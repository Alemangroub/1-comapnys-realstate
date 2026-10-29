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
    const projectId = url.searchParams.get("projectId");

    // 1. Internal Notifications for this user role
    const notifications = await prisma.internalNotification.findMany({
      where: {
        OR: [
          { userId: user.userId },
          { targetRole: user.role },
          { targetRole: null }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    // 2. Tasks
    const tasks = await prisma.systemTask.findMany({
      where: user.role === "admin" ? {} : { assignedToId: user.userId },
      include: {
        createdBy: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    // 3. Construction Photo Updates
    const whereUpdates = projectId ? { projectId } : {};
    const constructionUpdates = await prisma.constructionUpdate.findMany({
      where: whereUpdates,
      include: { project: { select: { id: true, projectName: true } } },
      orderBy: { publishedAt: "desc" }
    });

    // 4. Client Support Tickets
    const tickets = await prisma.clientTicket.findMany({
      orderBy: { createdAt: "desc" }
    });

    return new Response(
      JSON.stringify({
        success: true,
        notifications,
        tasks,
        constructionUpdates,
        tickets
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Communications API GET error:", error);
    return new Response(JSON.stringify({ error: "فشل جلب بيانات التواصل" }), { status: 500 });
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

    // 1. Create System Task
    if (body.action === "create_task") {
      const { assignedToId, projectId, title, description, dueDate, priority } = body;
      if (!assignedToId || !title) {
        return new Response(JSON.stringify({ error: "الموظف المكلف وعنوان المهمة مطلوبان" }), { status: 400 });
      }

      const task = await prisma.systemTask.create({
        data: {
          createdById: user.userId,
          assignedToId,
          projectId: projectId || null,
          title: title.trim(),
          description: description?.trim() || null,
          dueDate: dueDate ? new Date(dueDate) : null,
          priority: priority || "normal",
          status: "todo"
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "SystemTask",
        entityId: task.id,
        details: `إسناد مهمة إدارية جديدة: "${task.title}" (الأولوية: ${task.priority})`,
        newValues: { title: task.title, priority: task.priority, dueDate: task.dueDate }
      });

      return new Response(JSON.stringify({ success: true, task }), { status: 201 });
    }

    // 2. Update Task Status
    if (body.action === "update_task_status") {
      const { taskId, status } = body;
      const task = await prisma.systemTask.update({
        where: { id: taskId },
        data: { status }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "SystemTask",
        entityId: task.id,
        details: `تحديث حالة المهمة "${task.title}" إلى: ${task.status}`,
        newValues: { status: task.status }
      });

      return new Response(JSON.stringify({ success: true, task }), { status: 200 });
    }

    // 3. Post Construction Update with Photos for Clients & Admin
    if (body.action === "post_construction_update") {
      const { projectId, title, description, imageUrls, notifyClients } = body;
      if (!projectId || !title) {
        return new Response(JSON.stringify({ error: "المشروع وعنوان التحديث مطلوبان" }), { status: 400 });
      }

      const update = await prisma.constructionUpdate.create({
        data: {
          projectId,
          title: title.trim(),
          description: description?.trim() || null,
          imageUrls: imageUrls || [],
          notifyClients: notifyClients !== undefined ? Boolean(notifyClients) : true
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "ConstructionUpdate",
        entityId: update.id,
        details: `نشر تحديث ميداني مصور للعملاء: "${update.title}"`,
        newValues: { title: update.title, projectId }
      });

      return new Response(JSON.stringify({ success: true, update }), { status: 201 });
    }

    // 4. Create Client Ticket
    if (body.action === "create_ticket") {
      const { clientName, clientPhone, projectId, subject, category, message } = body;
      if (!clientName || !clientPhone || !subject) {
        return new Response(JSON.stringify({ error: "بيانات التذكرة غير مكتملة" }), { status: 400 });
      }

      const ticket = await prisma.clientTicket.create({
        data: {
          clientId: user.userId,
          clientName: clientName.trim(),
          clientPhone: clientPhone.trim(),
          projectId: projectId || null,
          subject: subject.trim(),
          category: category || "general",
          status: "open",
          messages: [{ sender: clientName, text: message || subject, time: new Date().toISOString() }]
        }
      });
      return new Response(JSON.stringify({ success: true, ticket }), { status: 201 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Communications API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية" }), { status: 500 });
  }
}
