import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "غير مصرح لك" }), { status: 401 });
    }

    const brokers = await prisma.brokerAgency.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        reservations: {
          select: {
            id: true,
            clientName: true,
            totalPrice: true,
            brokerCommission: true,
            brokerCommissionPaid: true,
            contractDate: true,
            status: true,
            project: { select: { projectName: true } },
            unit: { select: { unitNumber: true } }
          }
        }
      }
    });

    // Compute live calculated totals for each broker
    const enrichedBrokers = brokers.map(b => {
      let liveSales = 0;
      let liveCommissions = 0;
      let livePaidCommissions = b.paidCommissions || 0;

      b.reservations.forEach(r => {
        if (r.status !== "cancelled") {
          liveSales += r.totalPrice || 0;
          liveCommissions += r.brokerCommission || 0;
        }
      });

      return {
        ...b,
        totalSalesMade: liveSales,
        totalCommissions: liveCommissions,
        remainingCommissions: Math.max(0, liveCommissions - livePaidCommissions)
      };
    });

    return new Response(JSON.stringify({ success: true, brokers: enrichedBrokers }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Brokers API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل استرجاع بيانات شركات التسويق" }), { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "غير مصرح لك" }), { status: 401 });
    }

    const body = await request.json();
    const { action } = body;

    // 1. إضافة شركة بروكر / وسيط عقاري جديد
    if (action === "create_broker") {
      const { name, contactPerson, phone, email, defaultCommRate, notes } = body;
      if (!name || !phone) {
        return new Response(JSON.stringify({ error: "اسم الشركة ورقم الهاتف مطلوبان" }), { status: 400 });
      }

      const broker = await prisma.brokerAgency.create({
        data: {
          name: name.trim(),
          contactPerson: contactPerson ? contactPerson.trim() : null,
          phone: phone.trim(),
          email: email ? email.trim() : null,
          defaultCommRate: defaultCommRate ? parseFloat(defaultCommRate) : 2.5,
          notes: notes || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "BrokerAgency",
        entityId: broker.id,
        details: `تسجيل شركة تسويق عقاري / بروكر جديد: "${broker.name}" بنسبة عمولة ${broker.defaultCommRate}%`,
        newValues: { name: broker.name, phone: broker.phone, defaultCommRate: broker.defaultCommRate }
      });

      return new Response(JSON.stringify({
        success: true,
        message: "تم تسجيل شركة التسويق / البروكر بنجاح",
        broker
      }), { status: 201 });
    }

    // 2. تعديل بيانات البروكر
    if (action === "update_broker") {
      const { id, name, contactPerson, phone, email, defaultCommRate, notes } = body;
      if (!id || !name || !phone) {
        return new Response(JSON.stringify({ error: "معرف الشركة والاسم ورقم الهاتف مطلوبة" }), { status: 400 });
      }

      const updated = await prisma.brokerAgency.update({
        where: { id },
        data: {
          name: name.trim(),
          contactPerson: contactPerson ? contactPerson.trim() : null,
          phone: phone.trim(),
          email: email ? email.trim() : null,
          defaultCommRate: defaultCommRate ? parseFloat(defaultCommRate) : 2.5,
          notes: notes || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "BrokerAgency",
        entityId: updated.id,
        details: `تحديث بيانات شركة التسويق العقاري: "${updated.name}" (${updated.phone})`,
        newValues: { name: updated.name, phone: updated.phone, defaultCommRate: updated.defaultCommRate }
      });

      return new Response(JSON.stringify({
        success: true,
        message: "تم تحديث بيانات البروكر بنجاح",
        broker: updated
      }), { status: 200 });
    }

    // 3. صرف دفعة من عمولة البروكر وتسميعها في الخزينة
    if (action === "pay_commission") {
      const { brokerId, reservationId, amount, treasuryId, notes } = body;
      if (!brokerId || !amount || parseFloat(amount) <= 0) {
        return new Response(JSON.stringify({ error: "معرف البروكر والمبلغ المصروف مطلوبان" }), { status: 400 });
      }

      const broker = await prisma.brokerAgency.findUnique({ where: { id: brokerId } });
      if (!broker) {
        return new Response(JSON.stringify({ error: "شركة البروكر غير موجودة" }), { status: 404 });
      }

      const payAmount = parseFloat(amount);

      // تحديد الخزينة
      let targetTreasury = null;
      if (treasuryId) {
        targetTreasury = await prisma.treasury.findUnique({ where: { id: treasuryId } });
      }
      if (!targetTreasury) {
        targetTreasury = await prisma.treasury.findFirst({ where: { isMain: true } });
      }
      if (!targetTreasury) {
        targetTreasury = await prisma.treasury.findFirst();
      }

      if (targetTreasury) {
        // التحقق من الرصيد
        if (targetTreasury.balance < payAmount) {
          return new Response(JSON.stringify({
            error: `رصيد الخزينة (${targetTreasury.balance.toLocaleString()} ج.م) غير كافٍ لصرف العمولة المطلوبة (${payAmount.toLocaleString()} ج.م)`
          }), { status: 400 });
        }

        // تسجيل حركة الصرف
        await prisma.transaction.create({
          data: {
            treasuryId: targetTreasury.id,
            type: "expense",
            amount: payAmount,
            category: "sales_commission",
            reservationId: reservationId || null,
            description: `صرف عمولة تسويق خارجية لشركة: ${broker.name} ${notes ? `(${notes})` : ""}`,
            recordedBy: user.name || "المدير المالي"
          }
        });

        // خصم المبلغ من الخزينة
        await prisma.treasury.update({
          where: { id: targetTreasury.id },
          data: { balance: { decrement: payAmount } }
        });
      }

      // زيادة المبلغ المسدد للبروكر
      const updatedBroker = await prisma.brokerAgency.update({
        where: { id: brokerId },
        data: {
          paidCommissions: { increment: payAmount }
        }
      });

      // إذا كان الصرف مرتبطاً بحجز محدد، تحديث حالته
      if (reservationId) {
        await prisma.reservation.update({
          where: { id: reservationId },
          data: { brokerCommissionPaid: true }
        });
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "PAY",
        entity: "BrokerAgency",
        entityId: brokerId,
        details: `صرف عمولة تسويق خارجية لشركة "${broker.name}" بقيمة ${payAmount.toLocaleString("ar-EG")} ج.م من الخزينة`,
        newValues: { brokerId, amount: payAmount, totalPaidCommissions: updatedBroker.paidCommissions },
        severity: "warning"
      });

      return new Response(JSON.stringify({
        success: true,
        message: `تم صرف عمولة قدرها ${payAmount.toLocaleString()} ج.م لشركة ${broker.name} بنجاح والتسميع في الخزينة`,
        broker: updatedBroker
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Brokers API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية على البروكرز" }), { status: 500 });
  }
}
