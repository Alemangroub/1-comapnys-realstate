import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    const phone = url.searchParams.get("phone");
    const reservationCode = url.searchParams.get("code");
    const reservationId = url.searchParams.get("reservationId");

    // 1. Client Portal Search (By Phone or Reservation Code)
    if (phone || reservationCode || reservationId) {
      const searchWhere = {};
      if (phone) searchWhere.clientPhone = { contains: phone.trim() };
      if (reservationId) searchWhere.id = reservationId;

      const reservations = await prisma.reservation.findMany({
        where: searchWhere,
        include: {
          project: { select: { id: true, projectName: true, projectAddress: true, expectedEndDate: true, status: true } },
          unit: { select: { id: true, unitNumber: true, unitType: true, floor: true, area: true, totalPrice: true, status: true } },
          scheduledInstallments: { orderBy: { dueDate: "asc" } },
          transfers: true
        }
      });

      // Also fetch related cheques for these reservations
      const resIds = reservations.map(r => r.id);
      const [cheques, inspections, alterations] = await Promise.all([
        prisma.bankCheque.findMany({
          where: { reservationId: { in: resIds } },
          orderBy: { dueDate: "asc" }
        }),
        prisma.unitInspection.findMany({
          where: { reservationId: { in: resIds } }
        }),
        prisma.customerAlterationRequest.findMany({
          where: { reservationId: { in: resIds } },
          orderBy: { createdAt: "desc" }
        })
      ]);

      const clientPortfolio = reservations.map(res => {
        const resCheques = cheques.filter(c => c.reservationId === res.id);
        const resInspections = inspections.filter(i => i.reservationId === res.id);
        const resAlterations = alterations.filter(a => a.reservationId === res.id);

        const totalPaidInstallments = (res.scheduledInstallments || [])
          .filter(i => i.status === "paid")
          .reduce((sum, i) => sum + i.amount, 0);

        const totalPaid = (res.downPayment || 0) + totalPaidInstallments;
        const remaining = Math.max(0, (res.totalPrice || res.unit?.totalPrice || 0) - totalPaid);

        return {
          reservation: {
            ...res,
            installments: res.scheduledInstallments
          },
          totalPaid,
          remainingBalance: remaining,
          cheques: resCheques,
          inspections: resInspections,
          alterations: resAlterations
        };
      });

      return new Response(
        JSON.stringify({
          success: true,
          portfolio: clientPortfolio
        }),
        { status: 200 }
      );
    }

    // 2. Default: Return All Alteration Requests for Admin/Engineer Management
    const alterations = await prisma.customerAlterationRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 100
    });

    const stats = {
      total: alterations.length,
      underReview: alterations.filter(a => a.status === "under_review").length,
      approved: alterations.filter(a => a.status === "approved" || a.status === "in_progress").length,
      completed: alterations.filter(a => a.status === "completed").length
    };

    return new Response(
      JSON.stringify({
        success: true,
        alterations,
        stats
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Client Portal GET error:", error);
    return new Response(
      JSON.stringify({ error: "فشل تحميل بيانات بوابة العميل" }),
      { status: 500 }
    );
  }
}

export async function POST({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    const body = await request.json();
    const { action } = body;

    // 1. Submit Architectural Alteration Request
    if (action === "submit_alteration") {
      const { reservationId, unitId, clientName, clientPhone, title, details, engineeringCost } = body;

      if (!title || !details) {
        return new Response(
          JSON.stringify({ error: "يرجى كتابة عنوان وتفاصيل التعديل المطلوب" }),
          { status: 400 }
        );
      }

      const created = await prisma.customerAlterationRequest.create({
        data: {
          reservationId: reservationId || "general",
          unitId: unitId || "general",
          clientName: clientName || "عميل استثماري",
          clientPhone: clientPhone || "-",
          title,
          details,
          engineeringCost: engineeringCost ? parseFloat(engineeringCost) : 0,
          status: "under_review"
        }
      });

      await createAuditLog({
        request,
        userId: user?.userId,
        userName: user?.name || clientName || "عميل",
        action: "CREATE",
        entity: "CustomerAlterationRequest",
        entityId: created.id,
        details: `تسجيل طلب تعديل معماري جديد: ${title} للعميل ${clientName}`
      });

      return new Response(
        JSON.stringify({ success: true, alteration: created }),
        { status: 201 }
      );
    }

    // 2. Update Alteration Status (Engineer Pricing & Approval)
    if (action === "update_alteration_status") {
      const { requestId, status, engineeringCost, engineerNotes, clientApproved } = body;

      const updated = await prisma.customerAlterationRequest.update({
        where: { id: requestId },
        data: {
          status: status || undefined,
          engineeringCost: engineeringCost !== undefined ? parseFloat(engineeringCost) : undefined,
          engineerNotes: engineerNotes !== undefined ? engineerNotes : undefined,
          clientApproved: clientApproved !== undefined ? !!clientApproved : undefined
        }
      });

      await createAuditLog({
        request,
        userId: user?.userId,
        userName: user?.name || "المهندس الاستشاري",
        action: "UPDATE",
        entity: "CustomerAlterationRequest",
        entityId: requestId,
        details: `تحديث حالة طلب التعديل المعماري #${requestId.substring(0, 6)} إلى ${status}`
      });

      return new Response(
        JSON.stringify({ success: true, alteration: updated }),
        { status: 200 }
      );
    }

    return new Response(
      JSON.stringify({ error: "الإجراء غير معروف" }),
      { status: 400 }
    );
  } catch (error) {
    console.error("Client Portal POST error:", error);
    return new Response(
      JSON.stringify({ error: "فشل معالجة الطلب" }),
      { status: 500 }
    );
  }
}
