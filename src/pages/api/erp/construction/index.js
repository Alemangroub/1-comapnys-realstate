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
    let projectId = url.searchParams.get("projectId");

    // 1. Get all active projects for the top selector
    const projects = await prisma.project.findMany({
      where: { archived: false },
      select: { id: true, projectName: true },
      orderBy: { createdAt: "desc" }
    });

    if (!projectId && projects.length > 0) {
      const bourj = projects.find(p => p.projectName.includes("برج النور"));
      projectId = bourj ? bourj.id : projects[0].id;
    }

    const whereProject = projectId ? { projectId } : {};

    // 2. Construction Phases (مراحل البناء)
    const stages = await prisma.constructionStage.findMany({
      where: whereProject,
      orderBy: [{ stageOrder: "asc" }, { createdAt: "asc" }]
    });

    // Calculate total project progress (متوسط نسب إنجاز المراحل)
    let totalProgress = 0;
    if (stages.length > 0) {
      const sum = stages.reduce((acc, curr) => acc + (curr.progress || curr.percentage || 0), 0);
      totalProgress = Math.round(sum / stages.length);
    }

    // 3. Contractors (المقاولين والمستخلصات)
    const contractors = await prisma.contractor.findMany({
      where: whereProject,
      orderBy: { createdAt: "desc" }
    });

    // 4. Inventory Materials & Logs (المخازن والخامات)
    const materials = await prisma.inventoryMaterial.findMany({
      where: whereProject,
      orderBy: { createdAt: "asc" }
    });

    const inventoryLogs = await prisma.inventoryLog.findMany({
      where: whereProject,
      include: {
        material: { select: { id: true, name: true, unit: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    // 5. Expense Requests (طلبات الصرف المالي لقسم الإنشاءات)
    const expenseRequests = await prisma.expenseRequest.findMany({
      where: {
        ...whereProject,
        department: "construction"
      },
      include: {
        project: { select: { id: true, projectName: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    // 6. BOQ (Bill of Quantities - مقايسة بنود الأعمال الإنشائية)
    const boqItems = await prisma.projectBOQItem.findMany({
      where: whereProject,
      orderBy: { createdAt: "asc" }
    });

    const totalBoqBudget = boqItems.reduce((sum, item) => sum + (item.totalBudget || 0), 0);
    const totalBoqSpent = boqItems.reduce((sum, item) => sum + (item.actualCostSpent || 0), 0);
    const boqVariance = totalBoqBudget - totalBoqSpent;

    // 7. Contractor Advanced Invoices (المستخلصات الهندسية والاستقطاعات)
    const contractorInvoices = await prisma.contractorInvoice.findMany({
      where: whereProject,
      include: {
        contractor: { select: { id: true, name: true, specialty: true, companyName: true } },
        contract: { select: { id: true, title: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    // 8. Unit Handover & Snagging List Inspections (محاضر الفحص والاستلام)
    const unitInspections = await prisma.unitInspection.findMany({
      where: whereProject,
      include: {
        unit: { select: { id: true, unitNumber: true, unitType: true, floor: true } }
      },
      orderBy: { inspectionDate: "desc" }
    });

    // 9. Units for this project
    const units = await prisma.unit.findMany({
      where: whereProject,
      select: { id: true, unitNumber: true, unitType: true, floor: true, status: true },
      orderBy: { unitNumber: "asc" }
    });

    return new Response(
      JSON.stringify({
        success: true,
        projects,
        selectedProjectId: projectId,
        totalProgress,
        stages,
        contractors,
        materials,
        inventoryLogs,
        expenseRequests,
        boqItems,
        totalBoqBudget,
        totalBoqSpent,
        boqVariance,
        contractorInvoices,
        unitInspections,
        units
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Construction API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل جلب بيانات الإنشاءات" }), { status: 500 });
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

    // -------------------------------------------------------------
    // 1. Update Phase Progress & Photo (تعديل نسبة الإنجاز وصورة المرحلة)
    // -------------------------------------------------------------
    if (body.action === "update_phase_progress") {
      const { stageId, progress, photoUrl, status, notes } = body;
      if (!stageId) {
        return new Response(JSON.stringify({ error: "معرف المرحلة مطلوب" }), { status: 400 });
      }

      const pVal = Math.min(100, Math.max(0, parseFloat(progress || 0)));
      const derivedStatus = status || (pVal >= 100 ? "completed" : pVal > 0 ? "in_progress" : "pending");

      const updateData = {
        progress: pVal,
        percentage: pVal,
        status: derivedStatus,
        completionDate: pVal >= 100 ? new Date() : null
      };

      if (photoUrl !== undefined) updateData.photoUrl = photoUrl ? photoUrl.trim() : null;
      if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;

      const updated = await prisma.constructionStage.update({
        where: { id: stageId },
        data: updateData
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "ConstructionStage",
        entityId: updated.id,
        details: `تحديث نسبة إنجاز مرحلة "${updated.name}" إلى ${updated.progress}% (الحالة: ${updated.status})`,
        newValues: { progress: updated.progress, status: updated.status, photoUrl: updated.photoUrl }
      });

      return new Response(JSON.stringify({ success: true, stage: updated }), { status: 200 });
    }

    // -------------------------------------------------------------
    // 2. Add New Construction Phase (إضافة مرحلة بناء جديدة)
    // -------------------------------------------------------------
    if (body.action === "add_phase") {
      const { projectId, name, progress, photoUrl, notes } = body;
      if (!projectId || !name) {
        return new Response(JSON.stringify({ error: "اسم المرحلة والمشروع مطلوبان" }), { status: 400 });
      }

      const pVal = Math.min(100, Math.max(0, parseFloat(progress || 0)));
      const status = pVal >= 100 ? "completed" : pVal > 0 ? "in_progress" : "pending";

      const count = await prisma.constructionStage.count({ where: { projectId } });

      const newPhase = await prisma.constructionStage.create({
        data: {
          projectId,
          name: name.trim(),
          stageOrder: count + 1,
          progress: pVal,
          percentage: pVal,
          status,
          photoUrl: photoUrl?.trim() || null,
          notes: notes?.trim() || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "ConstructionStage",
        entityId: newPhase.id,
        details: `إضافة مرحلة بناء جديدة: "${newPhase.name}" بنسبة إنجاز أولية ${newPhase.progress}%`,
        newValues: { name: newPhase.name, progress: newPhase.progress, stageOrder: newPhase.stageOrder }
      });

      return new Response(JSON.stringify({ success: true, stage: newPhase }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 3. Add New Contractor (إضافة مقاول جديد)
    // -------------------------------------------------------------
    if (body.action === "add_contractor") {
      const { projectId, name, specialty, phone, contractAmount, paidAmount, companyName } = body;
      if (!projectId || !name || !specialty) {
        return new Response(JSON.stringify({ error: "اسم المقاول والتخصص والمشروع مطلوبة" }), { status: 400 });
      }

      const cAmt = parseFloat(contractAmount || 0);
      const pAmt = parseFloat(paidAmount || 0);
      const rAmt = Math.max(0, cAmt - pAmt);

      const contractor = await prisma.contractor.create({
        data: {
          projectId,
          name: name.trim(),
          specialty: specialty.trim(),
          phone: phone?.trim() || null,
          companyName: companyName?.trim() || null,
          contractAmount: cAmt,
          paidAmount: pAmt,
          remainingAmount: rAmt
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Contractor",
        entityId: contractor.id,
        details: `تسجيل مقاول/شركة مقاولات جديدة: "${contractor.name}" (${contractor.specialty}) بإجمالي عقد ${cAmt.toLocaleString("ar-EG")} ج.م`,
        newValues: { name: contractor.name, specialty: contractor.specialty, contractAmount: cAmt }
      });

      return new Response(JSON.stringify({ success: true, contractor }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 4. Pay Contractor Installment (تسجيل دفعة لمقاول)
    // -------------------------------------------------------------
    if (body.action === "pay_contractor") {
      const { contractorId, paymentAmount } = body;
      if (!contractorId || !paymentAmount) {
        return new Response(JSON.stringify({ error: "بيانات الدفعة غير مكتملة" }), { status: 400 });
      }

      const pAmt = parseFloat(paymentAmount);
      const contractor = await prisma.contractor.findUnique({ where: { id: contractorId } });
      if (!contractor) {
        return new Response(JSON.stringify({ error: "المقاول غير موجود" }), { status: 404 });
      }

      const newPaid = contractor.paidAmount + pAmt;
      const newRemaining = Math.max(0, contractor.contractAmount - newPaid);

      const updated = await prisma.contractor.update({
        where: { id: contractorId },
        data: {
          paidAmount: newPaid,
          remainingAmount: newRemaining
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "PAY",
        entity: "Contractor",
        entityId: contractor.id,
        details: `تسجيل دفعة مالية للمقاول "${contractor.name}" بقيمة ${pAmt.toLocaleString("ar-EG")} ج.م (المتبقي: ${newRemaining.toLocaleString("ar-EG")} ج.م)`,
        oldValues: { paidAmount: contractor.paidAmount, remainingAmount: contractor.remainingAmount },
        newValues: { paidAmount: newPaid, remainingAmount: newRemaining }
      });

      return new Response(JSON.stringify({ success: true, contractor: updated }), { status: 200 });
    }

    // -------------------------------------------------------------
    // 5. Add New Material to Inventory (إضافة خامة جديدة للمخزن)
    // -------------------------------------------------------------
    if (body.action === "add_material") {
      const { projectId, name, unit, initialStock, notes } = body;
      if (!projectId || !name || !unit) {
        return new Response(JSON.stringify({ error: "اسم الخامة ووحدة القياس مطلوبان" }), { status: 400 });
      }

      const stock = parseFloat(initialStock || 0);

      const material = await prisma.inventoryMaterial.create({
        data: {
          projectId,
          name: name.trim(),
          unit: unit.trim(),
          currentStock: stock,
          notes: notes?.trim() || null
        }
      });

      if (stock > 0) {
        await prisma.inventoryLog.create({
          data: {
            projectId,
            materialId: material.id,
            type: "in",
            quantity: stock,
            engineerName: user.name || "المهندس المشرف",
            notes: "رصيد افتتاحي للمخزن"
          }
        });
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "InventoryMaterial",
        entityId: material.id,
        details: `إضافة صنف خامة جديد للمخزن: "${material.name}" برصيد ${stock} ${material.unit}`,
        newValues: { name: material.name, unit: material.unit, currentStock: stock }
      });

      return new Response(JSON.stringify({ success: true, material }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 6. Log Inventory Movement (توريد خامة In أو سحب خامة Out)
    // -------------------------------------------------------------
    if (body.action === "log_inventory_movement") {
      const { projectId, materialId, type, quantity, engineerName, notes } = body;
      if (!projectId || !materialId || !type || !quantity) {
        return new Response(JSON.stringify({ error: "بيانات حركة المخزن غير مكتملة" }), { status: 400 });
      }

      const qty = parseFloat(quantity);
      if (qty <= 0) {
        return new Response(JSON.stringify({ error: "الكمية يجب أن تكون أكبر من صفر" }), { status: 400 });
      }

      const material = await prisma.inventoryMaterial.findUnique({ where: { id: materialId } });
      if (!material) {
        return new Response(JSON.stringify({ error: "الخامة غير موجودة بالمخزن" }), { status: 404 });
      }

      if (type === "out" && material.currentStock < qty) {
        return new Response(
          JSON.stringify({
            error: `الرصيد المتاح بالمخزن (${material.currentStock} ${material.unit}) غير كافٍ لسحب ${qty} ${material.unit}`
          }),
          { status: 400 }
        );
      }

      const stockChange = type === "in" ? qty : -qty;

      const [updatedMaterial, log] = await prisma.$transaction([
        prisma.inventoryMaterial.update({
          where: { id: materialId },
          data: { currentStock: { increment: stockChange } }
        }),
        prisma.inventoryLog.create({
          data: {
            projectId,
            materialId,
            type,
            quantity: qty,
            engineerName: engineerName?.trim() || user.name || "المهندس المشرف",
            notes: notes?.trim() || null
          }
        })
      ]);

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "InventoryMaterial",
        entityId: material.id,
        details: `حركة مخزن (${type === "in" ? "توريد وارد للمخزن" : "صرف خامات للبناء"}): كمية ${qty} ${material.unit} من خامة "${material.name}" (الرصيد بعد الحركة: ${updatedMaterial.currentStock} ${material.unit})`,
        oldValues: { currentStock: material.currentStock },
        newValues: { currentStock: updatedMaterial.currentStock, movementType: type, quantity: qty }
      });

      return new Response(JSON.stringify({ success: true, material: updatedMaterial, log }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 7. Create Expense Request to Treasury (رفع طلب صرف نقدية للخزنة)
    // -------------------------------------------------------------
    if (body.action === "create_expense_request") {
      const { projectId, title, category, amount, requesterName, description } = body;
      if (!projectId || !title || !amount) {
        return new Response(JSON.stringify({ error: "بيانات طلب الصرف غير مكتملة" }), { status: 400 });
      }

      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) {
        return new Response(JSON.stringify({ error: "المبلغ يجب أن يكون رقماً موجباً" }), { status: 400 });
      }

      const expenseReq = await prisma.expenseRequest.create({
        data: {
          projectId,
          department: "construction",
          requesterName: requesterName?.trim() || user.name || "مهندس الموقع",
          title: title.trim(),
          category: category || "operational",
          amount: amt,
          description: description?.trim() || null,
          status: "pending"
        }
      });

      // Send alert notification to Finance team
      await prisma.internalNotification.create({
        data: {
          targetRole: "finance",
          title: "طلب صرف جديد من الموقع",
          message: `رفع قسم الإنشاءات طلب صرف جديد بقيمة ${amt.toLocaleString("ar-EG")} ج.م بعنوان: "${title.trim()}".`
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "ExpenseRequest",
        entityId: expenseReq.id,
        details: `رفع طلب صرف نقدية من موقع المشروع بقيمة ${amt.toLocaleString("ar-EG")} ج.م بعنوان: "${title.trim()}"`,
        newValues: { title: expenseReq.title, amount: amt, department: "construction" }
      });

      return new Response(JSON.stringify({ success: true, expenseRequest: expenseReq }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 8. Add BOQ Item (إضافة بند جديد لمقايسة الأعمال)
    // -------------------------------------------------------------
    if (body.action === "add_boq_item") {
      const { projectId, itemCode, category, description, unit, estimatedQty, unitCost } = body;
      if (!projectId || !itemCode || !description || !estimatedQty || !unitCost) {
        return new Response(JSON.stringify({ error: "بيانات بند المقايسة غير مكتملة" }), { status: 400 });
      }

      const eq = parseFloat(estimatedQty);
      const uc = parseFloat(unitCost);
      const totalBudget = Math.round(eq * uc * 100) / 100;

      const boqItem = await prisma.projectBOQItem.create({
        data: {
          projectId,
          itemCode: itemCode.trim(),
          category: category || "concrete",
          description: description.trim(),
          unit: unit ? unit.trim() : "m3",
          estimatedQty: eq,
          unitCost: uc,
          totalBudget,
          actualCostSpent: 0,
          actualQtyUsed: 0
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "ProjectBOQItem",
        entityId: boqItem.id,
        details: `إضافة بند مقايسة أعمال جديد [${boqItem.itemCode}] "${boqItem.description}" بميزانية تقديرية ${totalBudget.toLocaleString("ar-EG")} ج.م`,
        newValues: { itemCode: boqItem.itemCode, totalBudget, unitCost: uc, estimatedQty: eq }
      });

      return new Response(JSON.stringify({ success: true, boqItem }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 9. Update BOQ Actual Spent (تسجيل منصرف فعلي لبند مقايسة)
    // -------------------------------------------------------------
    if (body.action === "update_boq_actuals") {
      const { boqItemId, addSpent, addQty } = body;
      if (!boqItemId) {
        return new Response(JSON.stringify({ error: "معرف بند المقايسة مطلوب" }), { status: 400 });
      }

      const spent = parseFloat(addSpent || 0);
      const qty = parseFloat(addQty || 0);

      const updated = await prisma.projectBOQItem.update({
        where: { id: boqItemId },
        data: {
          actualCostSpent: { increment: spent },
          actualQtyUsed: { increment: qty }
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "ProjectBOQItem",
        entityId: updated.id,
        details: `تسجيل منصرف فعلي لبند مقايسة [${updated.itemCode}]: صرف إضافي ${spent.toLocaleString("ar-EG")} ج.م وكمية منفذة ${qty}`,
        newValues: { actualCostSpent: updated.actualCostSpent, actualQtyUsed: updated.actualQtyUsed }
      });

      return new Response(JSON.stringify({ success: true, boqItem: updated }), { status: 200 });
    }

    // -------------------------------------------------------------
    // 10. Create Contractor Advanced Invoice (إصدار مستخلص هندسي مع الاستقطاعات)
    // -------------------------------------------------------------
    if (body.action === "create_contractor_invoice") {
      const {
        projectId,
        contractorId,
        invoiceNumber,
        stageDescription,
        grossAmount,
        retentionRate,
        advanceDeducted,
        taxDeducted,
        dueDate,
        notes
      } = body;

      if (!projectId || !contractorId || !grossAmount) {
        return new Response(JSON.stringify({ error: "بيانات المستخلص وقيمة الأعمال مطلوبة" }), { status: 400 });
      }

      const gross = parseFloat(grossAmount);
      const retRate = retentionRate !== undefined && retentionRate !== "" ? parseFloat(retentionRate) : 5.0;
      const retAmount = Math.round((gross * (retRate / 100)) * 100) / 100;
      const advDeduct = parseFloat(advanceDeducted || 0);
      const taxDeduct = parseFloat(taxDeducted || 0);
      const netPayable = Math.max(0, Math.round((gross - retAmount - advDeduct - taxDeduct) * 100) / 100);

      const invoice = await prisma.contractorInvoice.create({
        data: {
          projectId,
          contractorId,
          invoiceNumber: invoiceNumber?.trim() || `INV-${Date.now().toString().slice(-5)}`,
          stageDescription: stageDescription?.trim() || "مستخلص أعمال جارية",
          grossAmount: gross,
          retentionRate: retRate,
          retentionAmount: retAmount,
          advanceDeducted: advDeduct,
          taxDeducted: taxDeduct,
          netAmountPayable: netPayable,
          amount: netPayable,
          status: "pending",
          consultantApproval: false,
          dueDate: dueDate ? new Date(dueDate) : null,
          notes: notes?.trim() || null
        },
        include: { contractor: true }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Invoice",
        entityId: invoice.id,
        details: `إصدار مستخلص مقاول رقم "${invoice.invoiceNumber}" للمقاول "${invoice.contractor?.name || ""}" بإجمالي أعمال ${gross.toLocaleString("ar-EG")} ج.م وصافي مستحق ${netPayable.toLocaleString("ar-EG")} ج.م (تأمين أعمال محتجز ${retAmount.toLocaleString("ar-EG")} ج.م بنسبة ${retRate}%)`,
        newValues: { invoiceNumber: invoice.invoiceNumber, grossAmount: gross, netAmountPayable: netPayable, retentionAmount: retAmount }
      });

      return new Response(JSON.stringify({ success: true, invoice }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 11. Approve Contractor Invoice (اعتماد الاستشاري الهندسي للمستخلص)
    // -------------------------------------------------------------
    if (body.action === "approve_contractor_invoice") {
      const { invoiceId } = body;
      if (!invoiceId) {
        return new Response(JSON.stringify({ error: "معرف المستخلص مطلوب" }), { status: 400 });
      }

      const invoice = await prisma.contractorInvoice.update({
        where: { id: invoiceId },
        data: {
          consultantApproval: true,
          status: "approved"
        },
        include: { contractor: true }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "APPROVE",
        entity: "Invoice",
        entityId: invoice.id,
        details: `اعتماد الاستشاري الهندسي لمستخلص مقاول رقم "${invoice.invoiceNumber}" لصالح "${invoice.contractor?.name || ""}" بصافي مستحق ${invoice.netAmountPayable.toLocaleString("ar-EG")} ج.م`,
        newValues: { status: "approved", consultantApproval: true, netAmountPayable: invoice.netAmountPayable }
      });

      return new Response(JSON.stringify({ success: true, invoice }), { status: 200 });
    }

    // -------------------------------------------------------------
    // 12. Pay Contractor Invoice from Treasury (صرف المستخلص من الخزينة)
    // -------------------------------------------------------------
    if (body.action === "pay_contractor_invoice") {
      const { invoiceId, treasuryId } = body;
      if (!invoiceId) {
        return new Response(JSON.stringify({ error: "معرف المستخلص مطلوب" }), { status: 400 });
      }

      const invoice = await prisma.contractorInvoice.findUnique({
        where: { id: invoiceId },
        include: { contractor: true, project: true }
      });

      if (!invoice) {
        return new Response(JSON.stringify({ error: "المستخلص غير موجود" }), { status: 404 });
      }

      if (invoice.status === "paid") {
        return new Response(JSON.stringify({ error: "تم صرف هذا المستخلص بالفعل" }), { status: 400 });
      }

      const netAmount = invoice.netAmountPayable || invoice.amount;
      const receiptNumber = `PAY-INV-${Date.now().toString().slice(-6)}`;

      // Deduct from Treasury
      let targetTreasury = null;
      if (treasuryId) {
        targetTreasury = await prisma.treasury.findUnique({ where: { id: treasuryId } });
      }
      if (!targetTreasury) {
        targetTreasury = (await prisma.treasury.findFirst({ where: { projectId: invoice.projectId } }))
          || (await prisma.treasury.findFirst({ where: { isMain: true } }));
      }

      if (targetTreasury) {
        await prisma.transaction.create({
          data: {
            treasuryId: targetTreasury.id,
            type: "expense",
            amount: netAmount,
            category: "contractor_invoice",
            projectId: invoice.projectId,
            description: `صرف مستخلص رقم ${invoice.invoiceNumber} للمقاول ${invoice.contractor?.name || ""} (صافي بعد استقطاع تأمين ${invoice.retentionAmount} ج.م) - إيصال: ${receiptNumber}`,
            recordedBy: user.name || "المدير المالي"
          }
        });

        await prisma.treasury.update({
          where: { id: targetTreasury.id },
          data: { balance: targetTreasury.balance - netAmount }
        });
      }

      // Update Contractor paid & remaining
      if (invoice.contractorId) {
        const contractor = await prisma.contractor.findUnique({ where: { id: invoice.contractorId } });
        if (contractor) {
          const newPaid = contractor.paidAmount + netAmount;
          const newRemaining = Math.max(0, contractor.contractAmount - newPaid);
          await prisma.contractor.update({
            where: { id: invoice.contractorId },
            data: { paidAmount: newPaid, remainingAmount: newRemaining }
          });
        }
      }

      // Mark Invoice Paid
      const updatedInvoice = await prisma.contractorInvoice.update({
        where: { id: invoiceId },
        data: {
          status: "paid",
          paidDate: new Date(),
          receiptNumber
        },
        include: { contractor: true }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "PAY",
        entity: "Invoice",
        entityId: invoice.id,
        details: `صرف وتسوية مستخلص مقاول رقم "${invoice.invoiceNumber}" للمقاول "${invoice.contractor?.name || ""}" بقيمة صافية ${netAmount.toLocaleString("ar-EG")} ج.م من الخزينة - إيصال سداد: ${receiptNumber}`,
        newValues: { status: "paid", netAmount, receiptNumber, paidDate: new Date() }
      });

      return new Response(JSON.stringify({ success: true, invoice: updatedInvoice, receiptNumber }), { status: 200 });
    }

    // -------------------------------------------------------------
    // 13. Create Unit Inspection & Snagging List (إنشاء محضر فحص واستلام)
    // -------------------------------------------------------------
    if (body.action === "create_unit_inspection") {
      const { projectId, unitId, inspectorName, clientName, snagItems, notes } = body;
      if (!projectId || !unitId || !clientName) {
        return new Response(JSON.stringify({ error: "بيانات الوحدة والعميل مطلوبة لإنشاء المحضر" }), { status: 400 });
      }

      const inspection = await prisma.unitInspection.create({
        data: {
          projectId,
          unitId,
          inspectorName: inspectorName?.trim() || user.name || "مهندس الجودة والتسليم",
          clientName: clientName.trim(),
          status: "snagging",
          snagItems: snagItems || [
            { id: 1, item: "فحص تمديدات السباكة والمحابس", status: "open", notes: "" },
            { id: 2, item: "فحص لوحة الكهرباء والبرايز والمفاتيح", status: "open", notes: "" },
            { id: 3, item: "فحص استواء الدهانات والأبواب والشبابيك", status: "open", notes: "" },
            { id: 4, item: "فحص سيراميك الأرضيات وميول الحمام والمطبخ", status: "open", notes: "" }
          ],
          notes: notes?.trim() || null
        },
        include: { unit: true }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "UnitInspection",
        entityId: inspection.id,
        details: `إنشاء محضر فحص واستلام هندسي للوحدة ${inspection.unit?.unitNumber || ""} للعميل "${clientName.trim()}"`,
        newValues: { unitId, clientName, status: "snagging" }
      });

      return new Response(JSON.stringify({ success: true, inspection }), { status: 201 });
    }

    // -------------------------------------------------------------
    // 14. Update Inspection / Handover Signoff (تحديث ملاحظات وتوقيع التسليم)
    // -------------------------------------------------------------
    if (body.action === "update_inspection_status") {
      const { inspectionId, status, snagItems, clientSigned, clientFeedback } = body;
      if (!inspectionId) {
        return new Response(JSON.stringify({ error: "معرف المحضر مطلوب" }), { status: 400 });
      }

      const updateData = {};
      if (status) updateData.status = status;
      if (snagItems !== undefined) updateData.snagItems = snagItems;
      if (clientSigned !== undefined) {
        updateData.clientSigned = !!clientSigned;
        if (clientSigned) {
          updateData.handoverDate = new Date();
          updateData.status = "completed";
        }
      }
      if (clientFeedback !== undefined) updateData.clientFeedback = clientFeedback;

      const updated = await prisma.unitInspection.update({
        where: { id: inspectionId },
        data: updateData,
        include: { unit: true }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "UnitInspection",
        entityId: updated.id,
        details: `تحديث محضر فحص الوحدة ${updated.unit?.unitNumber || ""}: حالة الفحص (${updated.status})${clientSigned ? " - تم توقيع العميل رسمياً على محضر الاستلام النهائي" : ""}`,
        newValues: { status: updated.status, clientSigned: updated.clientSigned, handoverDate: updated.handoverDate }
      });

      return new Response(JSON.stringify({ success: true, inspection: updated }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Construction API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية" }), { status: 500 });
  }
}
