import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

const DEFAULT_COA = [
  // 1. الأصول (Assets)
  { code: "1", nameAr: "الأصول", accountType: "asset", isParent: true },
  { code: "11", nameAr: "الأصول المتداولة", accountType: "asset", isParent: true, parentCode: "1" },
  { code: "1101", nameAr: "النقدية بالخزينة الرئيسية والفرعية", accountType: "asset", parentCode: "11" },
  { code: "1102", nameAr: "الحسابات البنكية وحسابات التحصيل", accountType: "asset", parentCode: "11" },
  { code: "1103", nameAr: "محفظة أوراق القبض (الشيكات في الخزنة)", accountType: "asset", parentCode: "11" },
  { code: "1104", nameAr: "عملاء ومدينو بيع الوحدات (الأقساط المستحقة)", accountType: "asset", parentCode: "11" },
  { code: "12", nameAr: "الأصول غير المتداولة ومشروعات التطوير", accountType: "asset", isParent: true, parentCode: "1" },
  { code: "1201", nameAr: "مشروعات عقارية تحت التنفيذ (WIP)", accountType: "asset", parentCode: "12" },

  // 2. الالتزامات (Liabilities)
  { code: "2", nameAr: "الالتزامات", accountType: "liability", isParent: true },
  { code: "21", nameAr: "الالتزامات المتداولة", accountType: "liability", isParent: true, parentCode: "2" },
  { code: "2101", nameAr: "دفعات مقدمة من العملاء وحجوزات", accountType: "liability", parentCode: "21" },
  { code: "2102", nameAr: "تأمينات أعمال محتجزة للمقاولين (Retention 5%)", accountType: "liability", parentCode: "21" },
  { code: "2103", nameAr: "مستحقو عمولات شركات البروكرز", accountType: "liability", parentCode: "21" },
  { code: "2104", nameAr: "مصلحة الضرائب وضرائب الخصم", accountType: "liability", parentCode: "21" },

  // 3. حقوق الملكية (Equity)
  { code: "3", nameAr: "حقوق الملكية", accountType: "equity", isParent: true },
  { code: "31", nameAr: "رأس المال والاحتياطيات", accountType: "equity", isParent: true, parentCode: "3" },
  { code: "3101", nameAr: "رأس المال المصدر والمدفوع", accountType: "equity", parentCode: "31" },
  { code: "3102", nameAr: "الأرباح المبقاة والمرحلة", accountType: "equity", parentCode: "31" },

  // 4. الإيرادات (Revenues)
  { code: "4", nameAr: "الإيرادات", accountType: "revenue", isParent: true },
  { code: "41", nameAr: "إيرادات النشاط العقاري", accountType: "revenue", isParent: true, parentCode: "4" },
  { code: "4101", nameAr: "إيرادات بيع وتسليم الوحدات العقارية", accountType: "revenue", parentCode: "41" },
  { code: "4102", nameAr: "رسوم التنازل وخدمات إعادة البيع", accountType: "revenue", parentCode: "41" },
  { code: "4103", nameAr: "فوائد وغرامات تأخير الأقساط", accountType: "revenue", parentCode: "41" },

  // 5. التكاليف والمصروفات (Expenses & Costs)
  { code: "5", nameAr: "المصروفات والتكاليف", accountType: "expense", isParent: true },
  { code: "51", nameAr: "تكاليف الإنشاءات والتطوير", accountType: "expense", isParent: true, parentCode: "5" },
  { code: "5101", nameAr: "تكلفة أعمال ومستخلصات المقاولين", accountType: "expense", parentCode: "51" },
  { code: "5102", nameAr: "تكلفة خامات ومواد البناء المنصرفة", accountType: "expense", parentCode: "51" },
  { code: "52", nameAr: "المصروفات التسويقية والبيعية", accountType: "expense", isParent: true, parentCode: "5" },
  { code: "5201", nameAr: "عمولات المبيعات والوسطاء والبروكرز", accountType: "expense", parentCode: "52" },
  { code: "53", nameAr: "المصروفات الإدارية والعمومية", accountType: "expense", isParent: true, parentCode: "5" },
  { code: "5301", nameAr: "أجور ورواتب ومصروفات تشغيلية", accountType: "expense", parentCode: "53" }
];

async function ensureAccountsSeeded() {
  const count = await prisma.account.count();
  if (count > 0) return;

  const codeToId = {};
  for (const acc of DEFAULT_COA) {
    const parentId = acc.parentCode ? codeToId[acc.parentCode] : null;
    const created = await prisma.account.create({
      data: {
        code: acc.code,
        nameAr: acc.nameAr,
        accountType: acc.accountType,
        isParent: !!acc.isParent,
        parentId: parentId || null
      }
    });
    codeToId[acc.code] = created.id;
  }
}

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user) {
      return new Response(JSON.stringify({ error: "غير مصرح لك" }), { status: 401 });
    }

    // Ensure chart of accounts exists
    await ensureAccountsSeeded();

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode"); // "coa", "journal", "forecast", or "all"

    // 1. Fetch Chart of Accounts with live computed balances
    const accounts = await prisma.account.findMany({
      orderBy: { code: "asc" },
      include: { children: true }
    });

    // Compute live balances from actual ERP modules
    const [
      totalSafeBalance,
      chequesSafeAggregate,
      chequesBankAggregate,
      unpaidInstallmentsAggregate,
      customerAdvancesAggregate,
      retentionsAggregate,
      transferFeesAggregate
    ] = await Promise.all([
      prisma.treasury.aggregate({ _sum: { balance: true } }),
      prisma.bankCheque.aggregate({ where: { status: "in_safe" }, _sum: { amount: true } }),
      prisma.bankCheque.aggregate({ where: { status: "under_collection" }, _sum: { amount: true } }),
      prisma.scheduledInstallment.aggregate({ where: { status: { not: "paid" } }, _sum: { amount: true } }),
      prisma.reservation.aggregate({ _sum: { downPayment: true } }),
      prisma.contractorInvoice.aggregate({ _sum: { retentionAmount: true } }),
      prisma.ownershipTransfer.aggregate({ _sum: { transferFee: true } })
    ]);

    const liveBalances = {
      "1101": totalSafeBalance._sum.balance || 0,
      "1102": chequesBankAggregate._sum.amount || 0,
      "1103": chequesSafeAggregate._sum.amount || 0,
      "1104": unpaidInstallmentsAggregate._sum.amount || 0,
      "2101": customerAdvancesAggregate._sum.downPayment || 0,
      "2102": retentionsAggregate._sum.retentionAmount || 0,
      "4102": transferFeesAggregate._sum.transferFee || 0
    };

    const enrichedAccounts = accounts.map(acc => ({
      ...acc,
      balance: liveBalances[acc.code] !== undefined ? liveBalances[acc.code] : acc.balance
    }));

    // 2. Journal Entries
    const journalEntries = await prisma.journalEntry.findMany({
      include: {
        lines: {
          include: { account: { select: { id: true, code: true, nameAr: true, accountType: true } } }
        }
      },
      orderBy: { entryDate: "desc" },
      take: 50
    });

    // 3. Cash Flow Forecasting (توقعات السيولة للأشهر الـ 6 القادمة)
    const now = new Date();
    const monthsForecast = [];
    const monthNamesAr = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
    
    let runningCash = totalSafeBalance._sum.balance || 0;

    for (let i = 0; i < 6; i++) {
      const targetDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const mName = `${monthNamesAr[targetDate.getMonth()]} ${targetDate.getFullYear()}`;

      // Inflow from installments due in this month
      const instAgg = await prisma.scheduledInstallment.aggregate({
        where: {
          status: { not: "paid" },
          dueDate: { gte: targetDate, lt: nextMonthDate }
        },
        _sum: { amount: true }
      });

      // Inflow from cheques due in this month
      const chkAgg = await prisma.bankCheque.aggregate({
        where: {
          status: { in: ["in_safe", "under_collection"] },
          dueDate: { gte: targetDate, lt: nextMonthDate }
        },
        _sum: { amount: true }
      });

      const totalInflow = (instAgg._sum.amount || 0) + (chkAgg._sum.amount || 0);

      // Outflow from contractor invoices due in this month
      const invAgg = await prisma.contractorInvoice.aggregate({
        where: {
          status: { not: "paid" },
          dueDate: { gte: targetDate, lt: nextMonthDate }
        },
        _sum: { netAmountPayable: true }
      });

      // Estimated operational costs base
      const totalOutflow = (invAgg._sum.netAmountPayable || 0);
      const netMonth = totalInflow - totalOutflow;
      runningCash += netMonth;

      monthsForecast.push({
        monthIndex: i + 1,
        monthName: mName,
        expectedInflow: totalInflow,
        expectedOutflow: totalOutflow,
        netFlow: netMonth,
        cumulativePosition: runningCash
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        accounts: enrichedAccounts,
        journalEntries,
        forecast: {
          currentLiquidity: totalSafeBalance._sum.balance || 0,
          months: monthsForecast
        }
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Accounting API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل جلب البيانات المحاسبية" }), { status: 500 });
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

    // 1. Create Custom Account in Chart of Accounts
    if (body.action === "create_account") {
      const { code, nameAr, nameEn, accountType, parentId, notes } = body;
      if (!code || !nameAr || !accountType) {
        return new Response(JSON.stringify({ error: "كود واسم ونوع الحساب مطلوب" }), { status: 400 });
      }

      const existing = await prisma.account.findUnique({ where: { code: code.trim() } });
      if (existing) {
        return new Response(JSON.stringify({ error: `كود الحساب (${code}) مسجل بالفعل` }), { status: 400 });
      }

      const account = await prisma.account.create({
        data: {
          code: code.trim(),
          nameAr: nameAr.trim(),
          nameEn: nameEn?.trim() || null,
          accountType,
          parentId: parentId || null,
          notes: notes?.trim() || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Account",
        entityId: account.id,
        details: `إضافة حساب جديد لدليل الحسابات الشامل: [${account.code}] "${account.nameAr}" (النوع: ${account.accountType})`,
        newValues: { code: account.code, nameAr: account.nameAr, accountType: account.accountType }
      });

      return new Response(JSON.stringify({ success: true, account }), { status: 201 });
    }

    // 2. Create Double-Entry Manual Journal Entry
    if (body.action === "create_journal_entry") {
      const { description, entryDate, lines, refType, refId } = body;
      if (!description || !Array.isArray(lines) || lines.length < 2) {
        return new Response(JSON.stringify({ error: "يجب إدخال بيان القيد وسطرين محاسبيين على الأقل" }), { status: 400 });
      }

      let totalDebit = 0;
      let totalCredit = 0;

      for (const line of lines) {
        const d = parseFloat(line.debit || 0);
        const c = parseFloat(line.credit || 0);
        totalDebit += d;
        totalCredit += c;
      }

      // Accounting golden rule: Debit must equal Credit
      totalDebit = Math.round(totalDebit * 100) / 100;
      totalCredit = Math.round(totalCredit * 100) / 100;

      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return new Response(
          JSON.stringify({
            error: `القيد غير متوازن محاسبياً! إجمالي المدين (${totalDebit.toLocaleString()} ج.م) لا يتطابق مع إجمالي الدائن (${totalCredit.toLocaleString()} ج.م)`
          }),
          { status: 400 }
        );
      }

      if (totalDebit <= 0) {
        return new Response(JSON.stringify({ error: "يجب أن تكون قيمة القيد أكبر من صفر" }), { status: 400 });
      }

      const entry = await prisma.journalEntry.create({
        data: {
          description: description.trim(),
          entryDate: entryDate ? new Date(entryDate) : new Date(),
          totalDebit,
          totalCredit,
          refType: refType || "manual",
          refId: refId || null,
          createdBy: user.name || "محاسب النظام",
          lines: {
            create: lines.map(line => ({
              accountId: line.accountId,
              debit: parseFloat(line.debit || 0),
              credit: parseFloat(line.credit || 0),
              costCenterId: line.costCenterId || null,
              description: line.description?.trim() || null
            }))
          }
        },
        include: {
          lines: {
            include: { account: true }
          }
        }
      });

      // Update account balances
      for (const line of lines) {
        const d = parseFloat(line.debit || 0);
        const c = parseFloat(line.credit || 0);
        const netChange = (line.accountType === "asset" || line.accountType === "expense") ? (d - c) : (c - d);

        await prisma.account.update({
          where: { id: line.accountId },
          data: { balance: { increment: netChange } }
        });
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "JournalEntry",
        entityId: entry.id,
        details: `إنشاء وترحيل قيد يومية محاسبي رقم #${entry.entryNumber}: "${entry.description}" بإجمالي طرفي ${totalDebit.toLocaleString("ar-EG")} ج.م (${lines.length} سطور محاسبية)`,
        newValues: { entryNumber: entry.entryNumber, totalDebit, totalCredit, linesCount: lines.length },
        severity: "warning"
      });

      return new Response(JSON.stringify({ success: true, entry }), { status: 201 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Accounting API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية المحاسبية" }), { status: 500 });
  }
}
