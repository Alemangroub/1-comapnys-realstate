import prisma from "../../../lib/prisma.js";
import { getAuthenticatedUser } from "../../../lib/server-auth.js";

export async function GET({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || user.role !== "admin") {
      return new Response(JSON.stringify({ error: "غير مصرح لك بالوصول" }), { status: 401 });
    }

    // 1. Projects & Development counts
    const totalProjects = await prisma.project.count({ where: { archived: false } });
    const totalUnits = await prisma.unit.count();
    const availableUnits = await prisma.unit.count({ where: { status: "available" } });
    const reservedUnits = await prisma.unit.count({ where: { status: "reserved" } });
    const soldUnits = await prisma.unit.count({ where: { status: "sold" } });

    // 2. Construction metrics
    const totalStages = await prisma.constructionStage.count();
    const activeContractors = await prisma.contractor.count();
    const pendingExpenseRequests = await prisma.expenseRequest.count({ where: { status: "pending" } });

    // 3. Sales metrics
    const totalLeads = await prisma.lead.count();
    const totalReservations = await prisma.reservation.count();

    // 4. Collection metrics
    const pendingInstallments = await prisma.scheduledInstallment.count({ where: { status: "pending" } });
    const lateInstallments = await prisma.scheduledInstallment.count({ where: { status: "late" } });

    // 5. Treasury balances
    const treasuries = await prisma.treasury.findMany();
    const totalTreasuryBalance = treasuries.reduce((sum, t) => sum + (t.balance || 0), 0);

    // 6. Communications & Tasks
    const activeTasks = await prisma.systemTask.count({ where: { status: { not: "completed" } } });
    const openTickets = await prisma.clientTicket.count({ where: { status: "open" } });

    return new Response(
      JSON.stringify({
        success: true,
        stats: {
          totalProjects,
          units: { total: totalUnits, available: availableUnits, reserved: reservedUnits, sold: soldUnits },
          construction: { stages: totalStages, contractors: activeContractors, pendingExpenses: pendingExpenseRequests },
          sales: { leads: totalLeads, reservations: totalReservations },
          collection: { pending: pendingInstallments, late: lateInstallments },
          treasury: { totalBalance: totalTreasuryBalance, accountsCount: treasuries.length },
          communications: { activeTasks, openTickets }
        }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("ERP Summary error:", error);
    return new Response(JSON.stringify({ error: "فشل استرجاع بيانات النظام" }), { status: 500 });
  }
}
