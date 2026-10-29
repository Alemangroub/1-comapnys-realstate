import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "غير مصرح لك" }), { status: 401 });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const projectId = url.searchParams.get("projectId");
    const reservationId = url.searchParams.get("reservationId");

    const where = {};
    if (status && status !== "all") {
      where.status = status;
    }
    if (reservationId) {
      where.reservationId = reservationId;
    }
    if (projectId && projectId !== "all") {
      where.reservation = { projectId };
    }

    // Fetch all cheques
    const cheques = await prisma.bankCheque.findMany({
      where,
      orderBy: { dueDate: "asc" },
      include: {
        reservation: {
          select: {
            id: true,
            clientName: true,
            clientPhone: true,
            clientNationalId: true,
            project: {
              select: { id: true, projectName: true }
            },
            unit: {
              select: { id: true, unitNumber: true }
            }
          }
        },
        installment: {
          select: {
            id: true,
            installmentNumber: true,
            title: true,
            amount: true,
            dueDate: true,
            status: true
          }
        }
      }
    });

    // Compute portfolio stats
    const allCheques = await prisma.bankCheque.findMany({
      where: projectId && projectId !== "all" ? { reservation: { projectId } } : {},
      select: { amount: true, status: true }
    });

    const stats = {
      total: allCheques.length,
      in_safe: allCheques.filter(c => c.status === "in_safe").length,
      under_collection: allCheques.filter(c => c.status === "under_collection").length,
      collected: allCheques.filter(c => c.status === "collected").length,
      bounced: allCheques.filter(c => c.status === "bounced").length,
      amounts: {
        total: allCheques.reduce((sum, c) => sum + c.amount, 0),
        in_safe: allCheques.filter(c => c.status === "in_safe").reduce((sum, c) => sum + c.amount, 0),
        under_collection: allCheques.filter(c => c.status === "under_collection").reduce((sum, c) => sum + c.amount, 0),
        collected: allCheques.filter(c => c.status === "collected").reduce((sum, c) => sum + c.amount, 0),
        bounced: allCheques.filter(c => c.status === "bounced").reduce((sum, c) => sum + c.amount, 0)
      }
    };

    return new Response(JSON.stringify({ success: true, cheques, stats }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Cheques API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل استرجاع بيانات الشيكات" }), { status: 500 });
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

    // 1. تسجيل دفعة شيكات جديدة لتعاقد
    if (action === "add_batch_cheques") {
      const { reservationId, cheques } = body;
      if (!reservationId || !Array.isArray(cheques) || cheques.length === 0) {
        return new Response(JSON.stringify({ error: "بيانات الشيكات ومعرف الحجز مطلوبة" }), { status: 400 });
      }

      const createdCheques = [];
      for (const item of cheques) {
        if (!item.chequeNumber || !item.bankName || !item.amount || !item.dueDate) continue;

        const cheque = await prisma.bankCheque.create({
          data: {
            reservationId,
            installmentId: item.installmentId || null,
            chequeNumber: String(item.chequeNumber).trim(),
            bankName: item.bankName.trim(),
            drawerName: item.drawerName ? item.drawerName.trim() : "",
            branch: item.branch ? item.branch.trim() : "",
            amount: parseFloat(item.amount),
            dueDate: new Date(item.dueDate),
            status: item.status || "in_safe",
            depositBank: item.depositBank || null,
            notes: item.notes || null
          }
        });
        createdCheques.push(cheque);
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "BankCheque",
        entityId: reservationId,
        details: `تسجيل وإيداع حافظة شيكات جديدة تضم ${createdCheques.length} شيكاً لصالح حجز #${reservationId}`,
        newValues: { chequesCount: createdCheques.length },
        severity: "warning"
      });

      return new Response(JSON.stringify({
        success: true,
        message: `تم تسجيل ${createdCheques.length} شيك في حافظة الشيكات بنجاح`,
        cheques: createdCheques
      }), { status: 201 });
    }

    // 2. تحديث حالة الشيك (إرسال للتحصيل / تسجيل ارتداد / تعديل)
    if (action === "update_status") {
      const { chequeId, newStatus, depositBank, bouncedReason, notes } = body;
      if (!chequeId || !newStatus) {
        return new Response(JSON.stringify({ error: "معرف الشيك والحالة الجديدة مطلوبان" }), { status: 400 });
      }

      const oldCheque = await prisma.bankCheque.findUnique({ where: { id: chequeId } });

      const updateData = { status: newStatus };
      if (depositBank !== undefined) updateData.depositBank = depositBank;
      if (bouncedReason !== undefined) updateData.bouncedReason = bouncedReason;
      if (notes !== undefined) updateData.notes = notes;

      const updated = await prisma.bankCheque.update({
        where: { id: chequeId },
        data: updateData
      });

      const isBounced = newStatus === "bounced";
      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: isBounced ? "BOUNCE" : "UPDATE",
        entity: "BankCheque",
        entityId: chequeId,
        details: isBounced
          ? `تسجيل ارتداد الشيك رقم (${updated.chequeNumber}) بقيمة ${updated.amount.toLocaleString()} ج.م - السبب: ${bouncedReason || 'غير محدد'}`
          : `تحديث حالة الشيك رقم (${updated.chequeNumber}) إلى [${newStatus}]`,
        oldValues: { status: oldCheque?.status },
        newValues: { status: newStatus, depositBank, bouncedReason },
        severity: isBounced ? "critical" : "warning"
      });

      return new Response(JSON.stringify({
        success: true,
        message: "تم تحديث حالة الشيك بنجاح",
        cheque: updated
      }), { status: 200 });
    }

    // 3. تحصيل الشيك الفعلي وتسميعه في الخزينة والقسط
    if (action === "collect_cheque") {
      const { chequeId, treasuryId, depositBank } = body;
      if (!chequeId) {
        return new Response(JSON.stringify({ error: "معرف الشيك مطلوب" }), { status: 400 });
      }

      const cheque = await prisma.bankCheque.findUnique({
        where: { id: chequeId },
        include: {
          reservation: {
            include: { project: true }
          },
          installment: true
        }
      });

      if (!cheque) {
        return new Response(JSON.stringify({ error: "الشيك غير موجود" }), { status: 404 });
      }

      // تحديد الخزينة المستهدفة
      let targetTreasury = null;
      if (treasuryId) {
        targetTreasury = await prisma.treasury.findUnique({ where: { id: treasuryId } });
      }
      if (!targetTreasury && cheque.reservation?.projectId) {
        targetTreasury = await prisma.treasury.findFirst({
          where: { projectId: cheque.reservation.projectId }
        });
      }
      if (!targetTreasury) {
        targetTreasury = await prisma.treasury.findFirst({
          where: { isMain: true }
        });
      }

      // تحديث حالة الشيك لمحصل
      const collectedCheque = await prisma.bankCheque.update({
        where: { id: chequeId },
        data: {
          status: "collected",
          collectedDate: new Date(),
          depositBank: depositBank || cheque.depositBank || "البنك الرئيسي",
          receiptNumber: `CHK-RCPT-${Date.now().toString().slice(-6)}`
        }
      });

      // إذا كان الشيك مربوطاً بقسط، نحدث حالة القسط
      if (cheque.installmentId) {
        await prisma.scheduledInstallment.update({
          where: { id: cheque.installmentId },
          data: {
            status: "paid",
            paidAmount: cheque.amount,
            paidDate: new Date(),
            paymentMethod: "bank_cheque",
            receiptNumber: collectedCheque.receiptNumber,
            notes: `تم السداد بموجب تحصيل الشيك رقم ${cheque.chequeNumber} مسحوب على ${cheque.bankName}`
          }
        });
      }

      // تسجيل الحركة المالية في الخزينة
      if (targetTreasury) {
        await prisma.transaction.create({
          data: {
            treasuryId: targetTreasury.id,
            type: "income",
            amount: cheque.amount,
            category: "installment",
            projectId: cheque.reservation?.projectId || null,
            reservationId: cheque.reservationId,
            scheduledInstallmentId: cheque.installmentId || null,
            description: `تحصيل شيك بنكي رقم (${cheque.chequeNumber}) - بنك ${cheque.bankName} - العميل: ${cheque.reservation?.clientName}`,
            recordedBy: user.name || "مسؤول التحصيل"
          }
        });

        // زيادة رصيد الخزينة
        await prisma.treasury.update({
          where: { id: targetTreasury.id },
          data: {
            balance: { increment: cheque.amount }
          }
        });
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "COLLECT",
        entity: "BankCheque",
        entityId: chequeId,
        details: `تحصيل وإيداع الشيك رقم (${cheque.chequeNumber}) مسحوب على ${cheque.bankName} بمبلغ ${cheque.amount.toLocaleString()} ج.م وإصدار إيصال ${collectedCheque.receiptNumber}`,
        newValues: {
          chequeNumber: cheque.chequeNumber,
          amount: cheque.amount,
          receiptNumber: collectedCheque.receiptNumber,
          treasuryName: targetTreasury?.name || "الخزينة الرئيسية"
        },
        severity: "warning"
      });

      return new Response(JSON.stringify({
        success: true,
        message: `تم تحصيل الشيك رقم ${cheque.chequeNumber} بنجاح وتوريد المبلغ (${cheque.amount.toLocaleString()} ج.م) في الخزينة`,
        cheque: collectedCheque
      }), { status: 200 });
    }

    // 4. استبدال شيك مرتد أو ملغي بشيك جديد
    if (action === "replace_cheque") {
      const { oldChequeId, newCheque } = body;
      if (!oldChequeId || !newCheque) {
        return new Response(JSON.stringify({ error: "بيانات الشيك القديم والجديد مطلوبة" }), { status: 400 });
      }

      const old = await prisma.bankCheque.findUnique({ where: { id: oldChequeId } });
      if (!old) {
        return new Response(JSON.stringify({ error: "الشيك القديم غير موجود" }), { status: 404 });
      }

      // تحديث الشيك القديم كمستبدل
      await prisma.bankCheque.update({
        where: { id: oldChequeId },
        data: {
          status: "replaced",
          notes: `${old.notes || ""}\n(تم استبداله بالشيك رقم ${newCheque.chequeNumber})`.trim()
        }
      });

      // إنشاء الشيك الجديد
      const created = await prisma.bankCheque.create({
        data: {
          reservationId: old.reservationId,
          installmentId: old.installmentId,
          chequeNumber: String(newCheque.chequeNumber).trim(),
          bankName: newCheque.bankName.trim(),
          drawerName: newCheque.drawerName ? newCheque.drawerName.trim() : old.drawerName,
          branch: newCheque.branch ? newCheque.branch.trim() : "",
          amount: parseFloat(newCheque.amount || old.amount),
          dueDate: new Date(newCheque.dueDate),
          status: "in_safe",
          notes: `بديل للشيك المستبدل رقم ${old.chequeNumber}. ${newCheque.notes || ""}`.trim()
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "REPLACE",
        entity: "BankCheque",
        entityId: created.id,
        details: `استبدال الشيك (${old.chequeNumber}) بشيك بديل جديد رقم (${created.chequeNumber}) بنفس القيمة ${created.amount.toLocaleString()} ج.م`,
        oldValues: { chequeNumber: old.chequeNumber, status: "replaced" },
        newValues: { chequeNumber: created.chequeNumber, dueDate: created.dueDate, status: "in_safe" },
        severity: "warning"
      });

      return new Response(JSON.stringify({
        success: true,
        message: `تم استبدال الشيك بنجاح وإصدار الشيك البديل رقم ${created.chequeNumber}`,
        newCheque: created
      }), { status: 201 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Cheques API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية على الشيكات" }), { status: 500 });
  }
}
