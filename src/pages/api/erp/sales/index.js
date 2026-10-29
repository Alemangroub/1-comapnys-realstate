import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "غير مصرح لك" }), { status: 401 });
    }

    const isSales = user.role === "sales";
    let allowedProjectIds = null;

    // Strict Scoping: Sales employees can only access assigned projects!
    if (isSales) {
      const assignments = await prisma.salesProjectAssignment.findMany({
        where: { userId: user.userId },
        select: { projectId: true }
      });
      allowedProjectIds = assignments.map(a => a.projectId);
    }

    const projectFilter = allowedProjectIds ? { id: { in: allowedProjectIds }, archived: false } : { archived: false };

    const projects = await prisma.project.findMany({
      where: projectFilter,
      select: {
        id: true,
        projectName: true,
        projectAddress: true,
        units: {
          select: {
            id: true,
            unitNumber: true,
            unitType: true,
            floor: true,
            roomsCount: true,
            bathroomsCount: true,
            view: true,
            finishingType: true,
            area: true,
            gardenArea: true,
            pricePerMeter: true,
            totalPrice: true,
            status: true,
            planImage: true,
            notes: true,
            building: { select: { id: true, name: true, buildingType: true } }
          }
        },
        paymentPlans: true
      }
    });

    const leads = await prisma.lead.findMany({
      where: isSales ? { assignedSalesId: user.userId } : {},
      include: {
        project: { select: { id: true, projectName: true } },
        activities: { orderBy: { createdAt: "desc" } }
      },
      orderBy: { createdAt: "desc" }
    });

    const reservations = await prisma.reservation.findMany({
      where: isSales ? { salesId: user.userId } : {},
      include: {
        unit: true,
        project: { select: { id: true, projectName: true } },
        paymentPlan: true,
        scheduledInstallments: true,
        broker: true,
        bankCheques: true,
        transfers: {
          orderBy: { transferDate: "desc" }
        }
      },
      orderBy: { contractDate: "desc" }
    });

    const brokers = await prisma.brokerAgency.findMany({
      orderBy: { name: "asc" }
    });

    // User Target & Commission Metrics
    const userRecord = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { id: true, name: true, monthlyTarget: true, commissionRate: true }
    });
    const monthlyTarget = userRecord?.monthlyTarget || 3000000;
    const commissionRate = userRecord?.commissionRate || 1.0;

    // Total active achieved sales volume by this rep
    const activeReservations = reservations.filter(r => r.status !== "cancelled");
    const totalAchievedSales = activeReservations.reduce((sum, r) => sum + (r.totalPrice || 0), 0);
    const targetProgressPercent = Math.min(100, Math.round((totalAchievedSales / monthlyTarget) * 100));

    // Total commission earned
    const totalCommissions = reservations.reduce((sum, r) => sum + (r.commissionAmount || 0), 0);
    const paidCommissions = reservations.filter(r => r.commissionPaid).reduce((sum, r) => sum + (r.commissionAmount || 0), 0);

    // Sales Pipeline Kanban Stats
    const pipelineStats = {
      new: { count: 0, budget: 0 },
      contacted: { count: 0, budget: 0 },
      meeting: { count: 0, budget: 0 },
      proposal: { count: 0, budget: 0 },
      won: { count: 0, budget: 0 },
      lost: { count: 0, budget: 0 }
    };
    leads.forEach(l => {
      const st = l.status || "new";
      if (pipelineStats[st]) {
        pipelineStats[st].count++;
        pipelineStats[st].budget += (l.budget || 0);
      }
    });

    return new Response(
      JSON.stringify({
        success: true,
        projects,
        leads,
        reservations,
        brokers,
        totalCommissions,
        paidCommissions,
        isSalesOnly: isSales,
        targetMetrics: {
          monthlyTarget,
          commissionRate,
          totalAchievedSales,
          targetProgressPercent,
          remainingTarget: Math.max(0, monthlyTarget - totalAchievedSales)
        },
        pipelineStats
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Sales API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل جلب بيانات المبيعات" }), { status: 500 });
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

    // 1. Admin assigns Sales Rep to a specific Project
    if (body.action === "assign_sales") {
      if (user.role !== "admin") {
        return new Response(JSON.stringify({ error: "صلاحية الأدمن مطلوبة" }), { status: 403 });
      }
      const { salesUserId, projectId } = body;
      const assignment = await prisma.salesProjectAssignment.upsert({
        where: { userId_projectId: { userId: salesUserId, projectId } },
        create: { userId: salesUserId, projectId },
        update: {}
      });
      return new Response(JSON.stringify({ success: true, assignment }), { status: 200 });
    }

    // 2. Record New Lead (عميل محتمل)
    if (body.action === "create_lead") {
      const { fullName, phone, email, projectId, budget, interestType, notes } = body;
      if (!fullName || !phone) {
        return new Response(JSON.stringify({ error: "اسم العميل ورقم الهاتف مطلوبان" }), { status: 400 });
      }

      const lead = await prisma.lead.create({
        data: {
          fullName: fullName.trim(),
          phone: phone.trim(),
          email: email?.trim() || null,
          projectId: projectId || null,
          assignedSalesId: user.role === "sales" ? user.userId : null,
          budget: budget ? parseFloat(budget) : null,
          interestType: interestType || "residential",
          status: "new",
          notes: notes?.trim() || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Lead",
        entityId: lead.id,
        details: `تسجيل عميل محتمل جديد: ${lead.fullName} (${lead.phone}) بميزانية متوقعة ${lead.budget ? lead.budget.toLocaleString() + ' ج.م' : 'غير محددة'}`,
        newValues: {
          fullName: lead.fullName,
          phone: lead.phone,
          budget: lead.budget,
          interestType: lead.interestType,
          status: lead.status
        }
      });

      return new Response(JSON.stringify({ success: true, lead }), { status: 201 });
    }

    // 3. Update Lead Status
    if (body.action === "update_lead_status") {
      const { leadId, status, notes } = body;
      const oldLead = await prisma.lead.findUnique({ where: { id: leadId } });

      const lead = await prisma.lead.update({
        where: { id: leadId },
        data: { status, notes: notes !== undefined ? notes : undefined }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "Lead",
        entityId: leadId,
        details: `تحديث حالة العميل (${lead.fullName}) من [${oldLead?.status}] إلى [${status}]`,
        oldValues: { status: oldLead?.status },
        newValues: { status }
      });

      return new Response(JSON.stringify({ success: true, lead }), { status: 200 });
    }

    // 3.1 Update Lead Pipeline Stage (مع دعم سبب الإلغاء والمتابعة القادمة)
    if (body.action === "update_lead_stage") {
      const { leadId, stage, lostReason, nextFollowUp, summary, details } = body;
      if (!leadId || !stage) {
        return new Response(JSON.stringify({ error: "معرف العميل والمرحلة مطلوبان" }), { status: 400 });
      }

      const stageLabels = {
        new: "عميل جديد",
        contacted: "تم التواصل",
        meeting: "معاينة ومقابلة",
        proposal: "عرض سعر وتفاوض",
        won: "حجز وتعاقد",
        lost: "صفقة ملغاة"
      };

      const oldLead = await prisma.lead.findUnique({ where: { id: leadId } });

      const updatedLead = await prisma.lead.update({
        where: { id: leadId },
        data: {
          status: stage,
          lostReason: stage === "lost" ? (lostReason || "أخرى") : null,
          nextFollowUp: nextFollowUp ? new Date(nextFollowUp) : undefined
        },
        include: {
          project: { select: { id: true, projectName: true } },
          activities: { orderBy: { createdAt: "desc" } }
        }
      });

      // Auto-log activity
      await prisma.leadActivity.create({
        data: {
          leadId,
          type: stage === "lost" ? "note" : (stage === "proposal" ? "proposal" : (stage === "meeting" ? "meeting" : "call")),
          summary: summary || `تغيير مرحلة العميل إلى [${stageLabels[stage] || stage}]`,
          details: details || (stage === "lost" ? `سبب الإلغاء: ${lostReason || "غير محدد"}` : null),
          performedBy: user.name || "مسؤول المبيعات"
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "Lead",
        entityId: leadId,
        details: `تغيير مسار العميل (${updatedLead.fullName}) إلى مرحلة [${stageLabels[stage] || stage}]` + (lostReason ? ` - سبب الإلغاء: ${lostReason}` : ""),
        oldValues: { status: oldLead?.status, lostReason: oldLead?.lostReason },
        newValues: { status: stage, lostReason, nextFollowUp }
      });

      return new Response(JSON.stringify({ success: true, lead: updatedLead }), { status: 200 });
    }

    // 3.2 Add Lead Activity (تسجيل مكالمة، اجتماع، محادثة واتساب، ملاحظة)
    if (body.action === "add_lead_activity") {
      const { leadId, type, summary, details, nextFollowUp } = body;
      if (!leadId || !summary) {
        return new Response(JSON.stringify({ error: "معرف العميل وملخص التواصل مطلوبان" }), { status: 400 });
      }

      const activity = await prisma.leadActivity.create({
        data: {
          leadId,
          type: type || "call",
          summary: summary.trim(),
          details: details?.trim() || null,
          performedBy: user.name || "مسؤول المبيعات"
        }
      });

      if (nextFollowUp) {
        await prisma.lead.update({
          where: { id: leadId },
          data: { nextFollowUp: new Date(nextFollowUp) }
        });
      }

      const updatedLead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: {
          project: { select: { id: true, projectName: true } },
          activities: { orderBy: { createdAt: "desc" } }
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "LeadActivity",
        entityId: activity.id,
        details: `تسجيل تواصل مع العميل (${updatedLead?.fullName || leadId}): ${summary}` + (nextFollowUp ? ` - متابعة قادمة: ${nextFollowUp}` : ""),
        newValues: { type: activity.type, summary: activity.summary, nextFollowUp }
      });

      return new Response(JSON.stringify({ success: true, activity, lead: updatedLead }), { status: 201 });
    }

    // 3.3 Instant Quotation Calculator (حاسبة ومولد عروض الأسعار السريعة)
    if (body.action === "calculate_quotation") {
      const {
        unitId,
        clientName,
        clientPhone,
        discountPercent,
        downPaymentPercent,
        installmentYears,
        installmentFrequency,
        maintenancePercent,
        startDate
      } = body;

      if (!unitId) {
        return new Response(JSON.stringify({ error: "يرجى تحديد الوحدة لحساب العرض" }), { status: 400 });
      }

      const unit = await prisma.unit.findUnique({
        where: { id: unitId },
        include: { project: true, building: true }
      });

      if (!unit) {
        return new Response(JSON.stringify({ error: "الوحدة المطلوبة غير موجودة" }), { status: 404 });
      }

      const basePrice = unit.totalPrice;
      const discPct = Math.max(0, parseFloat(discountPercent || 0));
      const discountAmount = Math.round((basePrice * discPct) / 100);
      const netPrice = basePrice - discountAmount;

      const dpPct = Math.max(0, parseFloat(downPaymentPercent || 10));
      const downPaymentAmount = Math.round((netPrice * dpPct) / 100);
      const remainingAmount = netPrice - downPaymentAmount;

      const years = Math.max(1, parseInt(installmentYears || 5));
      const freq = installmentFrequency || "quarterly";
      const freqMultiplier = { monthly: 12, quarterly: 4, semi_annual: 2, annual: 1 };
      const periodsPerYr = freqMultiplier[freq] || 4;
      const totalInstallmentsCount = years * periodsPerYr;
      const installmentAmount = totalInstallmentsCount > 0 ? Math.round(remainingAmount / totalInstallmentsCount) : 0;

      const maintPct = parseFloat(maintenancePercent !== undefined ? maintenancePercent : (unit.project?.maintenancePercentage || 5));
      const maintenanceAmount = Math.round((netPrice * maintPct) / 100);

      // Simulated Installment Schedule
      const schedule = [];
      const baseDate = startDate ? new Date(startDate) : new Date();
      const monthStep = 12 / periodsPerYr;

      for (let i = 1; i <= totalInstallmentsCount; i++) {
        const d = new Date(baseDate);
        d.setMonth(d.getMonth() + Math.round(i * monthStep));
        const dateStr = d.toISOString().split("T")[0];
        schedule.push({
          num: i,
          dueDate: dateStr,
          amount: installmentAmount,
          title: `قسط ${i} من ${totalInstallmentsCount}`
        });
      }

      return new Response(JSON.stringify({
        success: true,
        quotation: {
          clientName: clientName?.trim() || "عميل مميز",
          clientPhone: clientPhone?.trim() || "-",
          unit: {
            id: unit.id,
            unitNumber: unit.unitNumber,
            unitType: unit.unitType,
            area: unit.area,
            floor: unit.floor,
            view: unit.view || "واجهة رئيسية",
            finishingType: unit.finishingType || "نصف تشطيب",
            projectName: unit.project?.projectName,
            projectAddress: unit.project?.projectAddress,
            buildingName: unit.building?.name || "-"
          },
          pricing: {
            basePrice,
            discountPercent: discPct,
            discountAmount,
            netPrice,
            downPaymentPercent: dpPct,
            downPaymentAmount,
            remainingAmount,
            installmentYears: years,
            installmentFrequency: freq,
            totalInstallmentsCount,
            installmentAmount,
            maintenancePercent: maintPct,
            maintenanceAmount,
            totalCommitment: netPrice + maintenanceAmount
          },
          schedule,
          salesRep: user.name || "مسؤول المبيعات",
          createdAt: new Date().toISOString()
        }
      }), { status: 200 });
    }

    // 3.4 Update Sales Rep Target & Commission
    if (body.action === "update_sales_target") {
      const { monthlyTarget, commissionRate } = body;
      await prisma.user.update({
        where: { id: user.userId },
        data: {
          monthlyTarget: monthlyTarget ? parseFloat(monthlyTarget) : undefined,
          commissionRate: commissionRate ? parseFloat(commissionRate) : undefined
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "User",
        entityId: user.userId,
        details: `تحديث المستهدف البيعي ونسبة العمولة لمسؤول المبيعات: ${user.name}`,
        newValues: { monthlyTarget, commissionRate },
        severity: "warning"
      });

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // 4. Reserve / Contract Unit (الحجز والتعاقد - القلب الرابط بين المبيعات والتحصيل والخزنة)
    if (body.action === "create_reservation") {
      const {
        projectId,
        unitId,
        leadId,
        clientName,
        clientPhone,
        clientNationalId,
        downPayment,
        paymentPlanId,
        commissionPercent,
        brokerId,
        brokerCommission
      } = body;

      if (!projectId || !unitId || !clientName || !clientPhone || downPayment === undefined) {
        return new Response(JSON.stringify({ error: "بيانات الحجز غير مكتملة" }), { status: 400 });
      }

      // Check unit status
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit || unit.status !== "available") {
        return new Response(JSON.stringify({ error: "الوحدة المختارة غير متاحة للبيع" }), { status: 400 });
      }

      const parsedDownPayment = parseFloat(downPayment);
      const commissionRate = commissionPercent ? parseFloat(commissionPercent) : 1.5; // default 1.5% commission
      const calculatedCommission = (unit.totalPrice * commissionRate) / 100;
      const parsedBrokerComm = brokerCommission ? parseFloat(brokerCommission) : 0;

      // 1. Create Reservation record
      const reservation = await prisma.reservation.create({
        data: {
          projectId,
          unitId,
          leadId: leadId || null,
          salesId: user.role === "sales" ? user.userId : null,
          clientName: clientName.trim(),
          clientPhone: clientPhone.trim(),
          clientNationalId: clientNationalId?.trim() || null,
          totalPrice: unit.totalPrice,
          downPayment: parsedDownPayment,
          paymentPlanId: paymentPlanId || null,
          status: "contracted",
          commissionAmount: calculatedCommission,
          commissionPaid: false,
          brokerId: brokerId || null,
          brokerCommission: parsedBrokerComm,
          brokerCommissionPaid: false
        }
      });

      // 2. Mark Unit as Sold
      await prisma.unit.update({
        where: { id: unitId },
        data: { status: "sold" }
      });

      // 3. Update Lead status to 'converted' if leadId provided
      if (leadId) {
        await prisma.lead.update({
          where: { id: leadId },
          data: { status: "converted" }
        });
      }

      // 4. Automatic Installment Scheduling (نظام التحصيل)
      const remainingAmount = unit.totalPrice - parsedDownPayment;
      const plan = paymentPlanId ? await prisma.paymentPlan.findUnique({ where: { id: paymentPlanId } }) : null;
      
      const years = plan ? plan.installmentYears : 3;
      const frequency = plan ? plan.installmentFrequency : "quarterly"; // quarterly or monthly
      const totalInstallmentsCount = frequency === "monthly" ? years * 12 : years * 4;
      const installmentAmount = Math.round((remainingAmount / totalInstallmentsCount) * 100) / 100;

      const scheduleData = [];
      const intervalMonths = frequency === "monthly" ? 1 : 3;
      const now = new Date();

      for (let i = 1; i <= totalInstallmentsCount; i++) {
        const dueDate = new Date(now);
        dueDate.setMonth(now.getMonth() + (i * intervalMonths));

        scheduleData.push({
          reservationId: reservation.id,
          installmentNumber: i,
          title: `قسط ${i} من ${totalInstallmentsCount}`,
          amount: installmentAmount,
          dueDate,
          status: "pending"
        });
      }

      if (scheduleData.length > 0) {
        await prisma.scheduledInstallment.createMany({
          data: scheduleData
        });
      }

      // 5. Automatic Treasury Income Recording (الخزينة المركزية وخزينة المشروع)
      const targetTreasury = await prisma.treasury.findFirst({ where: { projectId } })
        || await prisma.treasury.findFirst({ where: { isMain: true } });

      if (targetTreasury && parsedDownPayment > 0) {
        await prisma.transaction.create({
          data: {
            treasuryId: targetTreasury.id,
            type: "income",
            amount: parsedDownPayment,
            category: "down_payment",
            projectId,
            reservationId: reservation.id,
            description: `مقدم تعاقد الوحدة ${unit.unitNumber} - العميل: ${clientName}`,
            recordedBy: user.name || "مسؤول المبيعات"
          }
        });

        await prisma.treasury.update({
          where: { id: targetTreasury.id },
          data: { balance: targetTreasury.balance + parsedDownPayment }
        });
      }

      // 6. Send Internal Broadcast Notification
      await prisma.internalNotification.create({
        data: {
          targetRole: "finance",
          title: "تعاقد وحدة جديد ومقدم مستلم",
          message: `تم التعاقد على الوحدة ${unit.unitNumber} بمقدم ${parsedDownPayment} ج.م للعميل ${clientName}`
        }
      });

      // 7. Audit Log
      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Reservation",
        entityId: reservation.id,
        details: `إبرام عقد بيع وحجز للوحدة (${unit.unitNumber}) باسم العميل (${clientName}) بمقدم ${parsedDownPayment.toLocaleString()} ج.م وقيمة إجمالية ${unit.totalPrice.toLocaleString()} ج.م`,
        newValues: {
          clientName,
          clientPhone,
          unitNumber: unit.unitNumber,
          totalPrice: unit.totalPrice,
          downPayment: parsedDownPayment,
          commissionAmount: calculatedCommission,
          brokerCommission: parsedBrokerComm
        },
        severity: "warning"
      });

      return new Response(JSON.stringify({ success: true, reservation }), { status: 201 });
    }

    // 5. Transfer Ownership (التنازل ونقل الملكية لعميل جديد وتوريد رسوم التنازل)
    if (body.action === "transfer_ownership") {
      const { reservationId, toClientName, toClientPhone, toClientNatId, transferFee, treasuryId, notes } = body;
      if (!reservationId || !toClientName || !toClientPhone) {
        return new Response(JSON.stringify({ error: "بيانات العميل الجديد وتحديد الحجز مطلوبة" }), { status: 400 });
      }

      const reservation = await prisma.reservation.findUnique({
        where: { id: reservationId },
        include: { unit: true, project: true }
      });

      if (!reservation) {
        return new Response(JSON.stringify({ error: "التعاقد غير موجود" }), { status: 404 });
      }

      const fee = parseFloat(transferFee || 0);
      const oldClient = reservation.clientName;

      // 1. Create Transfer Record
      const transfer = await prisma.ownershipTransfer.create({
        data: {
          reservationId,
          fromClientName: oldClient,
          toClientName: toClientName.trim(),
          toClientPhone: toClientPhone.trim(),
          toClientNatId: toClientNatId?.trim() || null,
          transferFee: fee,
          notes: notes?.trim() || null
        }
      });

      // 2. Update Reservation Client Details
      const updatedReservation = await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          clientName: toClientName.trim(),
          clientPhone: toClientPhone.trim(),
          clientNationalId: toClientNatId?.trim() || reservation.clientNationalId
        },
        include: { unit: true, project: true, transfers: true }
      });

      // 3. Deposit Transfer Fee into Treasury if > 0
      if (fee > 0) {
        let targetTreasury = null;
        if (treasuryId) {
          targetTreasury = await prisma.treasury.findUnique({ where: { id: treasuryId } });
        }
        if (!targetTreasury) {
          targetTreasury = (await prisma.treasury.findFirst({ where: { projectId: reservation.projectId } }))
            || (await prisma.treasury.findFirst({ where: { isMain: true } }));
        }

        if (targetTreasury) {
          await prisma.transaction.create({
            data: {
              treasuryId: targetTreasury.id,
              type: "income",
              amount: fee,
              category: "transfer_fee",
              projectId: reservation.projectId,
              reservationId: reservation.id,
              description: `رسوم تنازل ونقل ملكية الوحدة ${reservation.unit?.unitNumber || ""} من (${oldClient}) إلى (${toClientName})`,
              recordedBy: user.name || "مسؤول المبيعات"
            }
          });

          await prisma.treasury.update({
            where: { id: targetTreasury.id },
            data: { balance: targetTreasury.balance + fee }
          });
        }
      }

      // 4. Send Internal Notification
      await prisma.internalNotification.create({
        data: {
          targetRole: "admin",
          title: "تنازل ونقل ملكية وحدة",
          message: `تم نقل ملكية الوحدة ${reservation.unit?.unitNumber || ""} من العميل (${oldClient}) إلى (${toClientName}) برسوم ${fee} ج.م`
        }
      });

      // 5. Audit Log
      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "TRANSFER",
        entity: "Reservation",
        entityId: reservationId,
        details: `اعتماد نقل ملكية وتنازل رسمي للوحدة (${reservation.unit?.unitNumber}) من العميل (${oldClient}) إلى العميل الجديد (${toClientName}) برسوم تنازل ${fee.toLocaleString()} ج.م`,
        oldValues: {
          clientName: oldClient,
          clientPhone: reservation.clientPhone,
          clientNationalId: reservation.clientNationalId
        },
        newValues: {
          clientName: toClientName,
          clientPhone: toClientPhone,
          clientNationalId: toClientNatId,
          transferFee: fee
        },
        severity: "critical"
      });

      return new Response(JSON.stringify({ success: true, transfer, reservation: updatedReservation }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Sales API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية" }), { status: 500 });
  }
}
