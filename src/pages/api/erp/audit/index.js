import prisma from "../../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../../lib/server-auth.js";
import { createAuditLog } from "../../../../lib/audit.js";

async function ensureSeedAuditLogs() {
  const count = await prisma.auditLog.count();
  if (count > 0) return;

  const now = new Date();
  const sampleLogs = [
    {
      userName: "المدير العام",
      userRole: "admin",
      action: "CREATE",
      entity: "Project",
      severity: "normal",
      details: "إنشاء واعتماد مشروع الأندلس بلازا الاستثماري الجديد",
      timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3)
    },
    {
      userName: "مدير المبيعات",
      userRole: "sales",
      action: "CREATE",
      entity: "Reservation",
      severity: "warning",
      details: "تسجيل حجز جديد للوحدة A-101 باسم العميل أحمد الشناوي",
      timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 2)
    },
    {
      userName: "مسؤول الخزينة",
      userRole: "finance",
      action: "APPROVE",
      entity: "BankCheque",
      severity: "warning",
      details: "استلام وقيد 12 شيكاً بنكياً في الخزينة لصالح حجز الوحدة A-101",
      timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 18)
    },
    {
      userName: "المدير المالي",
      userRole: "finance",
      action: "APPROVE",
      entity: "Invoice",
      severity: "warning",
      details: "اعتماد مستخلص مقاولات الخرسانات رقم 1 لمشروع الأندلس بعد استقطاع 5% ضمان أعمال",
      timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 12)
    },
    {
      userName: "المدير العام",
      userRole: "admin",
      action: "TRANSFER",
      entity: "Reservation",
      severity: "critical",
      details: "اعتماد نقل ملكية وتنازل رسمي للوحدة B-204 وتحصيل رسوم التنازل 50,000 ج.م",
      timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 4)
    },
    {
      userName: "المحاسب العام",
      userRole: "accountant",
      action: "CREATE",
      entity: "JournalEntry",
      severity: "normal",
      details: "قيد يومية مزدوج رقم JV-1001 لإثبات تسوية الأقساط الشهرية",
      timestamp: new Date(now.getTime() - 1000 * 60 * 60 * 1)
    }
  ];

  for (const item of sampleLogs) {
    await prisma.auditLog.create({
      data: {
        userName: item.userName,
        userRole: item.userRole,
        action: item.action,
        entity: item.entity,
        severity: item.severity,
        details: item.details,
        ipAddress: "192.168.1.10",
        timestamp: item.timestamp
      }
    });
  }
}

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || user.role !== "admin") {
      return new Response(JSON.stringify({ error: "غير مصرح لك: سجل الرقابة والتدقيق الأمني متاح حصرياً للمدير العام (Admin) فقط." }), { status: 403 });
    }

    // Auto-seed initial logs if empty
    await ensureSeedAuditLogs();

    const url = new URL(request.url);
    const entity = url.searchParams.get("entity");
    const action = url.searchParams.get("action");
    const severity = url.searchParams.get("severity");
    const search = url.searchParams.get("search");
    const exportFormat = url.searchParams.get("export"); // "csv"

    const whereClause = {};

    if (entity && entity !== "all") {
      whereClause.entity = entity;
    }

    if (action && action !== "all") {
      whereClause.action = action;
    }

    if (severity && severity !== "all") {
      whereClause.severity = severity;
    }

    if (search && search.trim() !== "") {
      const q = search.trim();
      whereClause.OR = [
        { details: { contains: q, mode: "insensitive" } },
        { userName: { contains: q, mode: "insensitive" } },
        { entityId: { contains: q, mode: "insensitive" } },
        { userRole: { contains: q, mode: "insensitive" } }
      ];
    }

    // CSV Export Handler
    if (exportFormat === "csv") {
      const allMatchingLogs = await prisma.auditLog.findMany({
        where: whereClause,
        orderBy: { timestamp: "desc" },
        take: 1000
      });

      const csvHeader = "\uFEFFالتاريخ والوقت,المستخدم,الدور,مستوى الخطورة,نوع الحركة,الكيان,معرف الكيان,البيان,عنوان IP\n";
      const csvRows = allMatchingLogs.map(l => {
        const timeStr = new Date(l.timestamp).toLocaleString("ar-EG");
        const clean = (txt) => `"${String(txt || '').replace(/"/g, '""')}"`;
        return [
          clean(timeStr),
          clean(l.userName),
          clean(l.userRole),
          clean(l.severity),
          clean(l.action),
          clean(l.entity),
          clean(l.entityId),
          clean(l.details),
          clean(l.ipAddress)
        ].join(",");
      }).join("\n");

      return new Response(csvHeader + csvRows, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit_trail_${new Date().toISOString().slice(0, 10)}.csv"`
        }
      });
    }

    const [logs, totalCount, todayCount, criticalCount, warningCount, financialCount] = await Promise.all([
      prisma.auditLog.findMany({
        where: whereClause,
        orderBy: { timestamp: "desc" },
        take: 200
      }),
      prisma.auditLog.count(),
      prisma.auditLog.count({
        where: {
          timestamp: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      prisma.auditLog.count({
        where: { severity: "critical" }
      }),
      prisma.auditLog.count({
        where: { severity: "warning" }
      }),
      prisma.auditLog.count({
        where: {
          action: { in: ["APPROVE", "TRANSFER", "RESCHEDULE", "BOUNCE", "PAY", "COLLECT"] }
        }
      })
    ]);

    return new Response(
      JSON.stringify({
        success: true,
        logs,
        stats: {
          totalCount,
          todayCount,
          criticalCount,
          warningCount,
          financialCount
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Audit GET error:", error);
    return new Response(
      JSON.stringify({ error: "حدث خطأ أثناء تحميل سجل التدقيق" }),
      { status: 500 }
    );
  }
}

export async function POST({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || user.role !== "admin") {
      return new Response(JSON.stringify({ error: "غير مصرح: مخصص للمدير العام فقط" }), { status: 403 });
    }

    const body = await request.json();
    const { action, entity, entityId, details, oldValues, newValues, severity } = body;

    const log = await createAuditLog({
      request,
      userId: user.userId,
      userName: user.name || "مستخدم مسجل",
      userRole: user.role || "admin",
      action: action || "CUSTOM_ACTION",
      entity: entity || "System",
      entityId,
      details,
      oldValues,
      newValues,
      severity
    });

    return new Response(JSON.stringify({ success: true, log }), { status: 201 });
  } catch (error) {
    console.error("Audit POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تسجيل الحركة" }), { status: 500 });
  }
}
