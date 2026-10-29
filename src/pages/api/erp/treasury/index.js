import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || (user.role !== "admin" && user.role !== "finance" && user.role !== "accountant")) {
      return new Response(JSON.stringify({ error: "غير مصرح لك بالوصول للخزينة" }), { status: 403 });
    }

    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const txType = url.searchParams.get("type");

    // 1. Get All Safes / Treasuries (Main Safe + Project Safes)
    const treasuries = await prisma.treasury.findMany({
      include: {
        project: { select: { id: true, projectName: true } }
      },
      orderBy: [{ isMain: "desc" }, { createdAt: "asc" }]
    });

    // 2. Filter Transactions
    const whereTx = {};
    if (projectId && projectId !== "all") whereTx.projectId = projectId;
    if (txType && txType !== "all") whereTx.type = txType;

    const transactions = await prisma.transaction.findMany({
      where: whereTx,
      include: {
        treasury: { select: { id: true, name: true, isMain: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });

    // 3. Project-by-Project Financial Performance Summary (الأرباح والتدفقات اللحظية لكل مشروع)
    const projects = await prisma.project.findMany({
      where: { archived: false },
      select: {
        id: true,
        projectName: true,
        treasuries: { select: { id: true, name: true, balance: true, isMain: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    const financialSummary = [];
    for (const proj of projects) {
      const incomes = await prisma.transaction.aggregate({
        where: { projectId: proj.id, type: "income" },
        _sum: { amount: true }
      });
      const expenses = await prisma.transaction.aggregate({
        where: { projectId: proj.id, type: "expense" },
        _sum: { amount: true }
      });

      const totalIncome = incomes._sum.amount || 0;
      const totalExpense = expenses._sum.amount || 0;
      const netProfit = totalIncome - totalExpense;
      const projectSafe = proj.treasuries.find(t => !t.isMain) || proj.treasuries[0];

      financialSummary.push({
        projectId: proj.id,
        projectName: proj.projectName,
        totalIncome,
        totalExpense,
        netProfit,
        safeName: projectSafe ? projectSafe.name : "خزينة المشروع",
        safeId: projectSafe ? projectSafe.id : null,
        currentBalance: proj.treasuries.reduce((sum, t) => sum + t.balance, 0)
      });
    }

    // 4. Pending & Historical Expense Requests (طلبات الصرف وموافقات المدير المالي)
    const expenseRequests = await prisma.expenseRequest.findMany({
      include: {
        project: { select: { id: true, projectName: true } },
        requestedBy: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    return new Response(
      JSON.stringify({
        success: true,
        treasuries,
        transactions,
        financialSummary,
        expenseRequests,
        projects: projects.map(p => ({ id: p.id, name: p.projectName }))
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Treasury API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل جلب بيانات الخزينة" }), { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || (user.role !== "admin" && user.role !== "finance" && user.role !== "accountant")) {
      return new Response(JSON.stringify({ error: "صلاحية إدارة الخزينة مطلوبة" }), { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.action) {
      return new Response(JSON.stringify({ error: "طلب غير صالح" }), { status: 400 });
    }

    // 1. Create New Treasury / Safe
    if (body.action === "create_treasury" || body.action === "create_safe") {
      const { name, projectId, initialBalance, isMain, safeType } = body;
      if (!name) {
        return new Response(JSON.stringify({ error: "اسم الخزنة مطلوب" }), { status: 400 });
      }

      const bal = initialBalance ? parseFloat(initialBalance) : 0;
      const treasury = await prisma.treasury.create({
        data: {
          name: name.trim(),
          projectId: projectId || null,
          safeType: safeType || (isMain ? "main" : "project"),
          balance: bal,
          isMain: Boolean(isMain)
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Treasury",
        entityId: treasury.id,
        details: `إنشاء خزينة جديدة: "${treasury.name}" برصيد افتتاحي ${bal.toLocaleString("ar-EG")} ج.م (${treasury.isMain ? "خزينة رئيسية" : "خزينة فرعية"})`,
        newValues: { name: treasury.name, balance: bal, isMain: treasury.isMain, safeType: treasury.safeType }
      });

      return new Response(JSON.stringify({ success: true, treasury }), { status: 201 });
    }

    // 2. Manual Funds Transaction (إيداع أو صرف مباشر)
    if (body.action === "manual_transaction") {
      const { treasuryId, type, amount, category, description, projectId } = body;
      if (!treasuryId || !type || !amount || !description) {
        return new Response(JSON.stringify({ error: "بيانات الحركة غير مكتملة" }), { status: 400 });
      }

      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) {
        return new Response(JSON.stringify({ error: "المبلغ يجب أن يكون رقماً موجباً" }), { status: 400 });
      }

      const tx = await prisma.transaction.create({
        data: {
          treasuryId,
          type, // income or expense
          amount: amt,
          category: category || "general_expense",
          projectId: projectId || null,
          description: description.trim(),
          recordedBy: user.name || "المحاسب"
        }
      });

      // Update Treasury Balance
      const delta = type === "income" ? amt : -amt;
      const updatedSafe = await prisma.treasury.update({
        where: { id: treasuryId },
        data: { balance: { increment: delta } }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: type === "income" ? "COLLECT" : "PAY",
        entity: "Treasury",
        entityId: treasuryId,
        details: `حركة ${type === "income" ? "إيداع نقدي وارد" : "صرف نقدي صادر"} بقيمة ${amt.toLocaleString("ar-EG")} ج.م في خزينة "${updatedSafe.name}" (${description.trim()}) - الرصيد بعد الحركة: ${updatedSafe.balance.toLocaleString("ar-EG")} ج.م`,
        newValues: { amount: amt, type, category, treasuryName: updatedSafe.name, newBalance: updatedSafe.balance },
        severity: "warning"
      });

      return new Response(JSON.stringify({ success: true, transaction: tx, balance: updatedSafe.balance }), { status: 201 });
    }

    // 3. Approve Expense Request (موافقة وصرف)
    if (body.action === "approve_expense_request") {
      const { requestId, treasuryId } = body;
      if (!requestId) {
        return new Response(JSON.stringify({ error: "معرف الطلب مطلوب" }), { status: 400 });
      }

      const req = await prisma.expenseRequest.findUnique({
        where: { id: requestId },
        include: { project: true }
      });

      if (!req) {
        return new Response(JSON.stringify({ error: "الطلب غير موجود" }), { status: 404 });
      }

      if (req.status === "approved") {
        return new Response(JSON.stringify({ error: "تم صرف هذا الطلب مسبقاً" }), { status: 400 });
      }

      // Determine target Treasury
      let targetSafe = null;
      if (treasuryId) {
        targetSafe = await prisma.treasury.findUnique({ where: { id: treasuryId } });
      }

      if (!targetSafe && req.projectId) {
        targetSafe = await prisma.treasury.findFirst({
          where: { projectId: req.projectId }
        });
      }

      if (!targetSafe) {
        targetSafe = await prisma.treasury.findFirst({
          where: { isMain: true }
        });
      }

      if (!targetSafe) {
        return new Response(JSON.stringify({ error: "لا توجد خزنة متاحة للخصم منها" }), { status: 400 });
      }

      // Update Expense Request
      const updatedReq = await prisma.expenseRequest.update({
        where: { id: requestId },
        data: {
          status: "approved",
          approvedAt: new Date(),
          approvedById: user.userId || null
        }
      });

      // Record Expense Transaction
      const deptLabels = {
        construction: "الإنشاءات",
        sales: "المبيعات",
        management: "الإدارة"
      };
      const deptName = deptLabels[req.department] || req.department;

      const tx = await prisma.transaction.create({
        data: {
          treasuryId: targetSafe.id,
          type: "expense",
          amount: req.amount,
          category: req.category || "operational",
          projectId: req.projectId,
          description: `صرف معتمد: ${req.title} (${deptName} - ${req.requesterName || "طلب إداري"})`,
          recordedBy: user.name || "المدير المالي"
        }
      });

      // Decrement Treasury Balance
      const updatedSafe = await prisma.treasury.update({
        where: { id: targetSafe.id },
        data: { balance: { decrement: req.amount } }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "APPROVE",
        entity: "ExpenseRequest",
        entityId: updatedReq.id,
        details: `اعتماد وصرف طلب نقدية بقيمة ${req.amount.toLocaleString("ar-EG")} ج.م بعنوان: "${req.title}" من خزينة "${targetSafe.name}" (${deptName})`,
        newValues: { requestId: req.id, amount: req.amount, targetSafe: targetSafe.name, safeBalanceAfter: updatedSafe.balance },
        severity: "warning"
      });

      return new Response(
        JSON.stringify({
          success: true,
          expenseRequest: updatedReq,
          transaction: tx,
          safeBalance: updatedSafe.balance
        }),
        { status: 200 }
      );
    }

    // 4. Reject Expense Request (رفض الطلب)
    if (body.action === "reject_expense_request") {
      const { requestId } = body;
      if (!requestId) {
        return new Response(JSON.stringify({ error: "معرف الطلب مطلوب" }), { status: 400 });
      }

      const updatedReq = await prisma.expenseRequest.update({
        where: { id: requestId },
        data: {
          status: "rejected",
          approvedAt: new Date(),
          approvedById: user.userId || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "REJECT",
        entity: "ExpenseRequest",
        entityId: updatedReq.id,
        details: `رفض طلب صرف نقدية بعنوان: "${updatedReq.title}" بقيمة ${updatedReq.amount.toLocaleString("ar-EG")} ج.م`,
        newValues: { status: "rejected", requestId: updatedReq.id },
        severity: "critical"
      });

      return new Response(JSON.stringify({ success: true, expenseRequest: updatedReq }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Treasury API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية" }), { status: 500 });
  }
}
