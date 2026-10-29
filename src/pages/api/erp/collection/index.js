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
    const unitId = url.searchParams.get("unitId");
    const reservationId = url.searchParams.get("reservationId");
    const status = url.searchParams.get("status");

    // 1. Get complete unit financial statement (كشف حساب الوحدة والأقساط)
    if (unitId) {
      const unit = await prisma.unit.findUnique({
        where: { id: unitId },
        include: {
          project: {
            include: {
              treasuries: true,
              paymentPlans: true
            }
          },
          building: true,
          reservations: {
            where: { status: { not: "cancelled" } },
            orderBy: { contractDate: "desc" },
            take: 1,
            include: {
              paymentPlan: true,
              scheduledInstallments: {
                orderBy: { dueDate: "asc" }
              }
            }
          }
        }
      });

      if (!unit) {
        return new Response(JSON.stringify({ error: "الوحدة غير موجودة" }), { status: 404 });
      }

      const reservation = unit.reservations && unit.reservations.length > 0 ? unit.reservations[0] : null;

      if (!reservation) {
        return new Response(
          JSON.stringify({
            success: true,
            hasReservation: false,
            unit,
            treasuries: unit.project?.treasuries || [],
            paymentPlans: unit.project?.paymentPlans || []
          }),
          { status: 200 }
        );
      }

      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      let totalPaidFromInstallments = 0;
      let overdueCount = 0;
      let overdueAmount = 0;
      let pendingCount = 0;
      let paidCount = 0;

      const processedInstallments = reservation.scheduledInstallments.map((inst) => {
        const dueDate = new Date(inst.dueDate);
        const isOverdue = inst.status === "pending" && dueDate < now;
        const isDueThisMonth =
          inst.status === "pending" &&
          dueDate.getMonth() === currentMonth &&
          dueDate.getFullYear() === currentYear;

        if (inst.status === "paid") {
          paidCount++;
          totalPaidFromInstallments += (inst.paidAmount || inst.amount);
        } else if (inst.status === "partially_paid") {
          totalPaidFromInstallments += (inst.paidAmount || 0);
          if (isOverdue) {
            overdueCount++;
            overdueAmount += (inst.amount - (inst.paidAmount || 0));
          } else {
            pendingCount++;
          }
        } else {
          // pending
          if (isOverdue) {
            overdueCount++;
            overdueAmount += inst.amount;
          } else {
            pendingCount++;
          }
        }

        return {
          ...inst,
          isOverdue,
          isDueThisMonth
        };
      });

      const totalPrice = reservation.totalPrice || unit.totalPrice;
      const downPayment = reservation.downPayment || 0;
      const totalPaid = downPayment + totalPaidFromInstallments;
      const totalRemaining = Math.max(0, totalPrice - totalPaid);
      const paidPercentage = totalPrice > 0 ? Math.min(100, Math.round((totalPaid / totalPrice) * 100)) : 0;

      return new Response(
        JSON.stringify({
          success: true,
          hasReservation: true,
          unit,
          reservation,
          installments: processedInstallments,
          summary: {
            totalPrice,
            downPayment,
            totalPaid,
            totalRemaining,
            paidPercentage,
            paidCount,
            pendingCount,
            overdueCount,
            overdueAmount
          },
          treasuries: unit.project?.treasuries || [],
          paymentPlans: unit.project?.paymentPlans || []
        }),
        { status: 200 }
      );
    }

    // 2. Default: fetch all scheduled installments
    const where = {};
    if (reservationId) where.reservationId = reservationId;
    if (status) where.status = status;

    const installments = await prisma.scheduledInstallment.findMany({
      where,
      include: {
        reservation: {
          include: {
            unit: true,
            project: { select: { id: true, projectName: true } }
          }
        }
      },
      orderBy: { dueDate: "asc" }
    });

    const now = new Date();
    const processedInstallments = installments.map(inst => {
      const isLate = inst.status === "pending" && new Date(inst.dueDate) < now;
      return {
        ...inst,
        isOverdue: isLate
      };
    });

    return new Response(JSON.stringify({ success: true, installments: processedInstallments }), { status: 200 });
  } catch (error) {
    console.error("Collection API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل جلب بيانات التحصيل" }), { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "غير مصرح لك" }), { status: 401 });
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.action) {
      return new Response(JSON.stringify({ error: "طلب غير صالح" }), { status: 400 });
    }

    // 1. Preview Schedule (محاكي توليد جدول الأقساط قبل الحفظ)
    if (body.action === "preview_schedule") {
      const {
        totalPrice,
        downPaymentPercent,
        downPaymentAmount,
        installmentYears,
        frequency,
        startDate,
        maintenancePercent
      } = body;

      const price = parseFloat(totalPrice) || 0;
      let dp = 0;
      if (downPaymentAmount !== undefined && downPaymentAmount !== "") {
        dp = parseFloat(downPaymentAmount) || 0;
      } else if (downPaymentPercent !== undefined && downPaymentPercent !== "") {
        dp = Math.round((price * (parseFloat(downPaymentPercent) / 100)) * 100) / 100;
      }

      const remaining = Math.max(0, price - dp);
      const years = parseInt(installmentYears) || 3;
      const freq = frequency || "quarterly"; // monthly, quarterly, semi_annual, annual

      let multiplier = 4;
      let monthStep = 3;
      if (freq === "monthly") {
        multiplier = 12;
        monthStep = 1;
      } else if (freq === "semi_annual") {
        multiplier = 2;
        monthStep = 6;
      } else if (freq === "annual") {
        multiplier = 1;
        monthStep = 12;
      }

      const totalInstallmentsCount = years * multiplier;
      const perInstallmentAmount = totalInstallmentsCount > 0 ? Math.round((remaining / totalInstallmentsCount) * 100) / 100 : 0;

      const schedule = [];
      const baseDate = startDate ? new Date(startDate) : new Date();

      for (let i = 1; i <= totalInstallmentsCount; i++) {
        const dueDate = new Date(baseDate);
        dueDate.setMonth(baseDate.getMonth() + (i * monthStep));

        schedule.push({
          installmentNumber: i,
          title: `قسط ${i} من ${totalInstallmentsCount}`,
          amount: perInstallmentAmount,
          dueDate: dueDate.toISOString().slice(0, 10),
          type: "periodic"
        });
      }

      // Add Maintenance deposit installment if specified
      let maintAmount = 0;
      if (maintenancePercent && parseFloat(maintenancePercent) > 0) {
        maintAmount = Math.round((price * (parseFloat(maintenancePercent) / 100)) * 100) / 100;
        const maintDate = new Date(baseDate);
        // Due at expected completion / last year
        maintDate.setMonth(baseDate.getMonth() + (totalInstallmentsCount * monthStep));

        schedule.push({
          installmentNumber: totalInstallmentsCount + 1,
          title: `وديعة الصيانة (${maintenancePercent}%)`,
          amount: maintAmount,
          dueDate: maintDate.toISOString().slice(0, 10),
          type: "maintenance"
        });
      }

      return new Response(
        JSON.stringify({
          success: true,
          schedule,
          summary: {
            totalPrice: price,
            downPayment: dp,
            remaining,
            totalInstallmentsCount,
            perInstallmentAmount,
            frequency: freq,
            maintenanceAmount: maintAmount
          }
        }),
        { status: 200 }
      );
    }

    // 2. Contract Unit with Schedule (حجز وتعاقد الوحدة وتوليد الأقساط وتوريد المقدم للخزنة)
    if (body.action === "contract_unit_with_schedule") {
      const {
        unitId,
        projectId,
        clientName,
        clientPhone,
        clientNationalId,
        totalPrice,
        downPayment,
        paymentPlanId,
        schedule,
        treasuryId,
        commissionPercent
      } = body;

      if (!unitId || !projectId || !clientName || !clientPhone) {
        return new Response(JSON.stringify({ error: "بيانات العميل والوحدة مطلوبة بالكامل" }), { status: 400 });
      }

      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit) {
        return new Response(JSON.stringify({ error: "الوحدة غير موجودة" }), { status: 404 });
      }

      if (unit.status === "sold") {
        return new Response(JSON.stringify({ error: "هذه الوحدة مباعة بالفعل ولا يمكن التعاقد عليها مجدداً" }), { status: 400 });
      }

      const parsedPrice = parseFloat(totalPrice || unit.totalPrice);
      const parsedDp = parseFloat(downPayment || 0);

      // Commission calculation
      const commRate = commissionPercent ? parseFloat(commissionPercent) : 1.5;
      const commissionAmount = (parsedPrice * commRate) / 100;

      // 1. Create Reservation
      const reservation = await prisma.reservation.create({
        data: {
          projectId,
          unitId,
          salesId: user.role === "sales" ? user.userId : null,
          clientName: clientName.trim(),
          clientPhone: clientPhone.trim(),
          clientNationalId: clientNationalId?.trim() || null,
          totalPrice: parsedPrice,
          downPayment: parsedDp,
          paymentPlanId: paymentPlanId || null,
          status: "contracted",
          commissionAmount,
          commissionPaid: false,
          contractDate: new Date()
        }
      });

      // 2. Mark Unit as Sold / Reserved
      await prisma.unit.update({
        where: { id: unitId },
        data: { status: "sold" }
      });

      // 3. Create Scheduled Installments in DB
      let createdInstallments = [];
      if (Array.isArray(schedule) && schedule.length > 0) {
        const scheduleData = schedule.map((item, idx) => ({
          reservationId: reservation.id,
          installmentNumber: idx + 1,
          title: item.title || `قسط ${idx + 1}`,
          amount: parseFloat(item.amount),
          dueDate: new Date(item.dueDate),
          status: "pending"
        }));

        await prisma.scheduledInstallment.createMany({
          data: scheduleData
        });

        createdInstallments = await prisma.scheduledInstallment.findMany({
          where: { reservationId: reservation.id },
          orderBy: { dueDate: "asc" }
        });
      }

      // 4. Deposit Down Payment into Selected Project / Main Treasury
      let targetTreasury = null;
      if (treasuryId) {
        targetTreasury = await prisma.treasury.findUnique({ where: { id: treasuryId } });
      }
      if (!targetTreasury) {
        targetTreasury =
          (await prisma.treasury.findFirst({ where: { projectId } })) ||
          (await prisma.treasury.findFirst({ where: { isMain: true } }));
      }

      let receiptNumber = null;
      if (targetTreasury && parsedDp > 0) {
        receiptNumber = `DP-${Date.now().toString().slice(-6)}`;

        await prisma.transaction.create({
          data: {
            treasuryId: targetTreasury.id,
            type: "income",
            amount: parsedDp,
            category: "down_payment",
            projectId,
            reservationId: reservation.id,
            description: `مقدم تعاقد الوحدة ${unit.unitNumber} - العميل: ${clientName} - إيصال: ${receiptNumber}`,
            recordedBy: user.name || "مسؤول النظام"
          }
        });

        await prisma.treasury.update({
          where: { id: targetTreasury.id },
          data: { balance: targetTreasury.balance + parsedDp }
        });
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Reservation",
        entityId: reservation.id,
        details: `إبرام عقد تعاقد وجدولة ${createdInstallments.length} قسطاً للوحدة ${unit.unitNumber} باسم (${clientName}) بإجمالي ${parsedPrice.toLocaleString()} ج.م ومقدم ${parsedDp.toLocaleString()} ج.م`,
        newValues: {
          clientName,
          clientPhone,
          totalPrice: parsedPrice,
          downPayment: parsedDp,
          installmentsCount: createdInstallments.length,
          receiptNumber
        },
        severity: "warning"
      });

      return new Response(
        JSON.stringify({
          success: true,
          reservation,
          installmentsCount: createdInstallments.length,
          receiptNumber,
          message: "تم حفظ العقد وجدولة الأقساط وتوريد المقدم للخزينة بنجاح"
        }),
        { status: 201 }
      );
    }

    // 3. Record Payment of Installment (سداد قسط وتوريد للخزنة وإصدار إيصال)
    if (body.action === "pay_installment") {
      const { installmentId, paidAmount, paymentMethod, latePenalty, notes, treasuryId } = body;
      if (!installmentId || paidAmount === undefined) {
        return new Response(JSON.stringify({ error: "بيانات القسط والمبلغ مطلوبة" }), { status: 400 });
      }

      const inst = await prisma.scheduledInstallment.findUnique({
        where: { id: installmentId },
        include: { reservation: { include: { unit: true, project: true } } }
      });

      if (!inst) {
        return new Response(JSON.stringify({ error: "القسط غير موجود" }), { status: 404 });
      }

      const receiptNumber = `REC-${Date.now().toString().slice(-6)}`;
      const amountPaid = parseFloat(paidAmount);
      const penalty = latePenalty ? parseFloat(latePenalty) : 0;
      const totalReceived = amountPaid + penalty;
      const newPaidTotal = (inst.paidAmount || 0) + amountPaid;
      const isFull = newPaidTotal >= inst.amount;

      // 1. Update Installment Status
      const updatedInstallment = await prisma.scheduledInstallment.update({
        where: { id: installmentId },
        data: {
          status: isFull ? "paid" : "partially_paid",
          paidAmount: newPaidTotal,
          paidDate: new Date(),
          receiptNumber,
          paymentMethod: paymentMethod || "cash",
          latePenalty: penalty,
          notes: notes?.trim() || null
        }
      });

      // 2. Deposit into Specific Project / Main Treasury
      const projectId = inst.reservation.projectId;
      let targetTreasury = null;
      if (treasuryId) {
        targetTreasury = await prisma.treasury.findUnique({ where: { id: treasuryId } });
      }
      if (!targetTreasury) {
        targetTreasury =
          (await prisma.treasury.findFirst({ where: { projectId } })) ||
          (await prisma.treasury.findFirst({ where: { isMain: true } }));
      }

      if (targetTreasury && totalReceived > 0) {
        await prisma.transaction.create({
          data: {
            treasuryId: targetTreasury.id,
            type: "income",
            amount: totalReceived,
            category: "installment",
            projectId,
            reservationId: inst.reservationId,
            scheduledInstallmentId: inst.id,
            description: `سداد ${inst.title} - الوحدة ${inst.reservation.unit.unitNumber} - إيصال: ${receiptNumber}`,
            recordedBy: user.name || "مسؤول التحصيل"
          }
        });

        await prisma.treasury.update({
          where: { id: targetTreasury.id },
          data: { balance: targetTreasury.balance + totalReceived }
        });
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "COLLECT",
        entity: "Reservation",
        entityId: inst.reservationId,
        details: `تحصيل قسط (${inst.title}) للوحدة ${inst.reservation.unit.unitNumber} بقيمة ${totalReceived.toLocaleString()} ج.م - إيصال رقم ${receiptNumber}`,
        newValues: {
          receiptNumber,
          unitNumber: inst.reservation.unit.unitNumber,
          clientName: inst.reservation.clientName,
          amountPaid,
          penalty,
          totalReceived,
          paymentMethod: paymentMethod || "cash"
        },
        severity: "warning"
      });

      return new Response(
        JSON.stringify({
          success: true,
          installment: updatedInstallment,
          receipt: {
            receiptNumber,
            clientName: inst.reservation.clientName,
            clientPhone: inst.reservation.clientPhone,
            unitNumber: inst.reservation.unit.unitNumber,
            projectName: inst.reservation.project.projectName,
            title: inst.title,
            amount: totalReceived,
            actualAmount: amountPaid,
            penalty,
            paymentMethod: paymentMethod || "cash",
            date: new Date().toISOString()
          }
        }),
        { status: 200 }
      );
    }

    // 4. Reschedule Installments (إعادة جدولة الأقساط المتبقية للعميل)
    if (body.action === "reschedule_installments") {
      const { reservationId, years, frequency, startDate, notes } = body;
      if (!reservationId) {
        return new Response(JSON.stringify({ error: "معرف التعاقد مطلوب" }), { status: 400 });
      }

      const reservation = await prisma.reservation.findUnique({
        where: { id: reservationId },
        include: {
          unit: true,
          scheduledInstallments: { orderBy: { dueDate: "asc" } }
        }
      });

      if (!reservation) {
        return new Response(JSON.stringify({ error: "التعاقد غير موجود" }), { status: 404 });
      }

      // Calculate unpaid remaining balance
      const paidInstallments = reservation.scheduledInstallments.filter(i => i.status === "paid");
      const unpaidInstallments = reservation.scheduledInstallments.filter(i => i.status !== "paid");

      if (unpaidInstallments.length === 0) {
        return new Response(JSON.stringify({ error: "جميع أقساط هذه الوحدة مسددة بالكامل بالفعل" }), { status: 400 });
      }

      let remainingAmount = 0;
      for (const inst of unpaidInstallments) {
        if (inst.status === "partially_paid") {
          remainingAmount += (inst.amount - (inst.paidAmount || 0));
        } else {
          remainingAmount += inst.amount;
        }
      }

      const numYears = parseInt(years) || 2;
      const freq = frequency || "quarterly";
      let multiplier = 4;
      let monthStep = 3;
      if (freq === "monthly") {
        multiplier = 12;
        monthStep = 1;
      } else if (freq === "semi_annual") {
        multiplier = 2;
        monthStep = 6;
      } else if (freq === "annual") {
        multiplier = 1;
        monthStep = 12;
      }

      const count = numYears * multiplier;
      const perInstallmentAmount = Math.round((remainingAmount / count) * 100) / 100;

      // Delete unpaid installments (keep paid ones safe)
      await prisma.scheduledInstallment.deleteMany({
        where: {
          reservationId,
          status: { not: "paid" }
        }
      });

      const baseDate = startDate ? new Date(startDate) : new Date();
      const paidCount = paidInstallments.length;
      const newSchedule = [];

      for (let i = 1; i <= count; i++) {
        const dueDate = new Date(baseDate);
        dueDate.setMonth(baseDate.getMonth() + (i * monthStep));

        newSchedule.push({
          reservationId,
          installmentNumber: paidCount + i,
          title: `قسط معاد جدولته (${i} من ${count})`,
          amount: perInstallmentAmount,
          dueDate,
          status: "pending",
          notes: notes ? `إعادة جدولة: ${notes}` : "معاد جدولته بتسوية معتمدة"
        });
      }

      await prisma.scheduledInstallment.createMany({
        data: newSchedule
      });

      const allInstallments = await prisma.scheduledInstallment.findMany({
        where: { reservationId },
        orderBy: { dueDate: "asc" }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "RESCHEDULE",
        entity: "Reservation",
        entityId: reservationId,
        details: `إعادة جدولة الأقساط المتبقية للوحدة ${reservation.unit?.unitNumber} بمبلغ ${remainingAmount.toLocaleString()} ج.م على ${count} قسطاً جديداً`,
        newValues: {
          remainingAmount,
          newInstallmentsCount: count,
          perInstallmentAmount,
          notes
        },
        severity: "warning"
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: `تمت إعادة جدولة ${remainingAmount.toLocaleString()} ج.م على ${count} قسط بنجاح`,
          installments: allInstallments,
          remainingAmount,
          newInstallmentsCount: count
        }),
        { status: 200 }
      );
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Collection API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية" }), { status: 500 });
  }
}

