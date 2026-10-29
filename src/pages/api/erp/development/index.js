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

    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
          buildings: { include: { units: true } },
          units: {
            include: {
              reservations: {
                where: { status: { not: "cancelled" } },
                include: {
                  paymentPlan: true,
                  scheduledInstallments: {
                    orderBy: { dueDate: "asc" }
                  }
                }
              }
            }
          },
          paymentPlans: true,
          constructionStages: true,
          treasuries: true,
          salesAssignments: { include: { user: { select: { id: true, name: true, role: true, email: true, phone: true } } } }
        }
      });
      return new Response(JSON.stringify({ success: true, project }), { status: 200 });
    }

    const archivedParam = url.searchParams.get("archived"); // "true", "false", "all"

    let whereClause = {};
    if (archivedParam === "true") {
      whereClause.archived = true;
    } else if (archivedParam === "all") {
      // Return all projects
    } else {
      // Default: active projects only
      whereClause.archived = false;
    }

    const [projects, activeCount, archivedCount, totalCount] = await Promise.all([
      prisma.project.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        include: {
          buildings: { select: { id: true, name: true, buildingType: true } },
          units: { select: { id: true, status: true, totalPrice: true } },
          paymentPlans: { select: { id: true, name: true } },
          constructionStages: { select: { id: true, percentage: true, weight: true } },
          treasuries: { select: { id: true, balance: true } },
          salesAssignments: { include: { user: { select: { id: true, name: true, role: true, email: true, phone: true } } } }
        }
      }),
      prisma.project.count({ where: { archived: false } }),
      prisma.project.count({ where: { archived: true } }),
      prisma.project.count()
    ]);

    return new Response(JSON.stringify({
      success: true,
      projects,
      counts: {
        active: activeCount,
        archived: archivedCount,
        total: totalCount
      }
    }), { status: 200 });
  } catch (error) {
    console.error("Development API GET error:", error);
    return new Response(JSON.stringify({ error: "خطأ أثناء جلب البيانات" }), { status: 500 });
  }
}

export async function POST({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || user.role !== "admin") {
      return new Response(JSON.stringify({ error: "صلاحية الأدمن مطلوبة" }), { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.action) {
      return new Response(JSON.stringify({ error: "طلب غير صالح" }), { status: 400 });
    }

    // 1. Create New Project (الأب الروحي)
    if (body.action === "create_project") {
      const {
        projectName,
        projectCode,
        projectType,
        maintenancePercentage,
        projectAddress,
        locationCoordinates,
        totalArea,
        startDate,
        expectedEndDate
      } = body;
      if (!projectName) {
        return new Response(JSON.stringify({ error: "اسم المشروع مطلوب" }), { status: 400 });
      }

      const project = await prisma.project.create({
        data: {
          projectName: projectName.trim(),
          projectCode: projectCode?.trim() || null,
          projectType: projectType?.trim() || null,
          maintenancePercentage: maintenancePercentage !== undefined && maintenancePercentage !== "" ? parseFloat(maintenancePercentage) : null,
          projectAddress: projectAddress?.trim() || null,
          locationCoordinates: locationCoordinates?.trim() || null,
          totalArea: totalArea ? parseFloat(totalArea) : null,
          startDate: startDate ? new Date(startDate) : null,
          expectedEndDate: expectedEndDate ? new Date(expectedEndDate) : null,
          status: "under_development"
        }
      });

      // Automatically initialize default construction stages for this project
      const defaultStages = [
        { name: "الحفر وتجهيز الموقع", stageOrder: 1, weight: 10 },
        { name: "الأساسات والخرسانة العادية والمسلحة", stageOrder: 2, weight: 25 },
        { name: "الهيكل الخرساني والأعمدة والأسقف", stageOrder: 3, weight: 30 },
        { name: "أعمال المباني والعزل", stageOrder: 4, weight: 15 },
        { name: "التشطيبات المعمارية والواجهات", stageOrder: 5, weight: 20 }
      ];

      for (const st of defaultStages) {
        await prisma.constructionStage.create({
          data: {
            projectId: project.id,
            name: st.name,
            stageOrder: st.stageOrder,
            weight: st.weight,
            percentage: 0,
            status: "pending"
          }
        });
      }

      // Automatically initialize a dedicated Treasury for this project
      await prisma.treasury.create({
        data: {
          projectId: project.id,
          name: `خزينة مشروع ${project.projectName}`,
          balance: 0,
          isMain: false
        }
      });

      // Save Assigned Staff (Sales, Engineers, Accountants)
      const assignedUserIds = body.assignedUserIds;
      if (Array.isArray(assignedUserIds) && assignedUserIds.length > 0) {
        for (const uid of assignedUserIds) {
          if (uid && typeof uid === 'string') {
            await prisma.salesProjectAssignment.create({
              data: {
                projectId: project.id,
                userId: uid
              }
            }).catch(() => null);
          }
        }
      }

      const fullProject = await prisma.project.findUnique({
        where: { id: project.id },
        include: {
          salesAssignments: { include: { user: { select: { id: true, name: true, role: true, email: true } } } }
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Project",
        entityId: project.id,
        details: `إنشاء مشروع استثماري جديد: ${project.projectName} (${project.projectCode || "-"}) وتخصيص الخزينة والمراحل الإنشائية`,
        newValues: {
          projectName: project.projectName,
          projectCode: project.projectCode,
          projectType: project.projectType,
          totalArea: project.totalArea,
          status: project.status
        }
      });

      return new Response(JSON.stringify({ success: true, project: fullProject || project }), { status: 201 });
    }

    // 2. Add Building Component (عمارة / فيلا / مول) مع إمكانية التوليد التلقائي للشقق
    if (body.action === "add_building") {
      const { projectId, name, buildingType, floorsCount, description, autoGeneratedUnits } = body;
      if (!projectId || !name) {
        return new Response(JSON.stringify({ error: "المشروع واسم المبنى مطلوبان" }), { status: 400 });
      }

      const building = await prisma.building.create({
        data: {
          projectId,
          name: name.trim(),
          buildingType: buildingType || "residential",
          floorsCount: floorsCount ? parseInt(floorsCount) : 1,
          description: description?.trim() || null
        }
      });

      let createdUnitsCount = 0;
      if (Array.isArray(autoGeneratedUnits) && autoGeneratedUnits.length > 0) {
        const unitsData = autoGeneratedUnits.map(u => {
          const area = parseFloat(u.area) || 120;
          const ppm = parseFloat(u.pricePerMeter) || 15000;
          const total = u.totalPrice ? parseFloat(u.totalPrice) : area * ppm;
          return {
            projectId,
            buildingId: building.id,
            unitNumber: String(u.unitNumber).trim(),
            unitType: u.unitType || 'residential',
            floor: parseInt(u.floor) !== undefined ? parseInt(u.floor) : 0,
            roomsCount: parseInt(u.roomsCount) || 3,
            area,
            pricePerMeter: ppm,
            totalPrice: total,
            status: u.status || 'available'
          };
        });

        await prisma.unit.createMany({
          data: unitsData
        });
        createdUnitsCount = unitsData.length;
      }

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Building",
        entityId: building.id,
        details: `إضافة مبنى (${building.name}) في مشروع #${projectId} مع توليد ${createdUnitsCount} وحدة`,
        newValues: { name: building.name, buildingType: building.buildingType, floorsCount: building.floorsCount, createdUnitsCount }
      });

      return new Response(JSON.stringify({
        success: true,
        building,
        createdUnitsCount,
        message: createdUnitsCount > 0
          ? `تم إنشاء المبنى وتوليد ${createdUnitsCount} شقة بنجاح 🏢✨`
          : 'تم إضافة المبنى بنجاح'
      }), { status: 201 });
    }

    // 3. Add Unit (شقة / دوبلكس / بنتهاوس / محل / فيلا)
    if (body.action === "add_unit") {
      const {
        projectId,
        buildingId,
        unitNumber,
        unitType,
        floor,
        roomsCount,
        bathroomsCount,
        view,
        finishingType,
        area,
        gardenArea,
        pricePerMeter,
        totalPrice,
        planImage,
        status,
        notes
      } = body;

      if (!projectId || !unitNumber || !area || !pricePerMeter) {
        return new Response(JSON.stringify({ error: "بيانات الوحدة والمساحة والأسعار مطلوبة" }), { status: 400 });
      }

      const parsedArea = parseFloat(area) || 0;
      const parsedPpm = parseFloat(pricePerMeter) || 0;
      const parsedGarden = parseFloat(gardenArea) || 0;
      const calculatedTotal = totalPrice !== undefined && totalPrice !== "" && totalPrice !== null
        ? parseFloat(totalPrice)
        : (parsedArea * parsedPpm);

      const unit = await prisma.unit.create({
        data: {
          projectId,
          buildingId: buildingId || null,
          unitNumber: String(unitNumber).trim(),
          unitType: unitType || "residential",
          floor: floor !== undefined ? parseInt(floor) : 0,
          roomsCount: roomsCount ? parseInt(roomsCount) : 1,
          bathroomsCount: bathroomsCount ? parseInt(bathroomsCount) : 1,
          view: view?.trim() || null,
          finishingType: finishingType?.trim() || null,
          area: parsedArea,
          gardenArea: parsedGarden,
          pricePerMeter: parsedPpm,
          totalPrice: calculatedTotal,
          planImage: planImage || null,
          status: status || "available",
          notes: notes?.trim() || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "Unit",
        entityId: unit.id,
        details: `إضافة وحدة جديدة (${unit.unitNumber}) بمساحة ${unit.area}م² وسعر إجمالي ${unit.totalPrice.toLocaleString()} ج.م`,
        newValues: {
          unitNumber: unit.unitNumber,
          unitType: unit.unitType,
          floor: unit.floor,
          area: unit.area,
          pricePerMeter: unit.pricePerMeter,
          totalPrice: unit.totalPrice,
          status: unit.status
        }
      });

      return new Response(JSON.stringify({ success: true, unit }), { status: 201 });
    }

    // 3.1 Update Single Unit (تعديل مواصفات وتسعير شقة محددة)
    if (body.action === "update_unit") {
      const {
        unitId,
        buildingId,
        unitNumber,
        unitType,
        floor,
        roomsCount,
        bathroomsCount,
        view,
        finishingType,
        area,
        gardenArea,
        pricePerMeter,
        totalPrice,
        planImage,
        status,
        notes
      } = body;

      if (!unitId) {
        return new Response(JSON.stringify({ error: "معرف الوحدة مطلوب" }), { status: 400 });
      }

      const oldUnit = await prisma.unit.findUnique({ where: { id: unitId } });

      const updateData = {};
      if (buildingId !== undefined) updateData.buildingId = buildingId || null;
      if (unitNumber !== undefined) updateData.unitNumber = String(unitNumber).trim();
      if (unitType !== undefined) updateData.unitType = unitType;
      if (floor !== undefined) updateData.floor = parseInt(floor) || 0;
      if (roomsCount !== undefined) updateData.roomsCount = parseInt(roomsCount) || 1;
      if (bathroomsCount !== undefined) updateData.bathroomsCount = parseInt(bathroomsCount) || 1;
      if (view !== undefined) updateData.view = view?.trim() || null;
      if (finishingType !== undefined) updateData.finishingType = finishingType?.trim() || null;
      if (notes !== undefined) updateData.notes = notes?.trim() || null;
      if (planImage !== undefined) updateData.planImage = planImage || null;
      if (status !== undefined) updateData.status = status;

      const parsedArea = area !== undefined ? parseFloat(area) : undefined;
      const parsedPpm = pricePerMeter !== undefined ? parseFloat(pricePerMeter) : undefined;
      if (gardenArea !== undefined) updateData.gardenArea = parseFloat(gardenArea) || 0;

      if (parsedArea !== undefined) updateData.area = parsedArea;
      if (parsedPpm !== undefined) updateData.pricePerMeter = parsedPpm;

      if (totalPrice !== undefined && totalPrice !== "" && totalPrice !== null) {
        updateData.totalPrice = parseFloat(totalPrice);
      } else if (parsedArea !== undefined && parsedPpm !== undefined) {
        updateData.totalPrice = parsedArea * parsedPpm;
      }

      const unit = await prisma.unit.update({
        where: { id: unitId },
        data: updateData
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "Unit",
        entityId: unitId,
        details: `تحديث بيانات وتسعير الوحدة (${unit.unitNumber})`,
        oldValues: oldUnit ? {
          unitNumber: oldUnit.unitNumber,
          area: oldUnit.area,
          pricePerMeter: oldUnit.pricePerMeter,
          totalPrice: oldUnit.totalPrice,
          status: oldUnit.status
        } : null,
        newValues: {
          unitNumber: unit.unitNumber,
          area: unit.area,
          pricePerMeter: unit.pricePerMeter,
          totalPrice: unit.totalPrice,
          status: unit.status
        }
      });

      return new Response(JSON.stringify({ success: true, unit }), { status: 200 });
    }

    // 3.2 Bulk Update Units (الحركة الذكية للتعديل والتسعير الجماعي بضغطة واحدة)
    if (body.action === "bulk_update_units") {
      const { unitIds, specs } = body;
      if (!Array.isArray(unitIds) || unitIds.length === 0) {
        return new Response(JSON.stringify({ error: "يرجى تحديد وحدة واحدة على الأقل للتعديل" }), { status: 400 });
      }
      if (!specs || typeof specs !== "object") {
        return new Response(JSON.stringify({ error: "المواصفات المراد تطبيقها غير محددة" }), { status: 400 });
      }

      const bulkData = {};
      if (specs.unitType) bulkData.unitType = specs.unitType;
      if (specs.roomsCount !== undefined && specs.roomsCount !== "") bulkData.roomsCount = parseInt(specs.roomsCount);
      if (specs.bathroomsCount !== undefined && specs.bathroomsCount !== "") bulkData.bathroomsCount = parseInt(specs.bathroomsCount);
      if (specs.view) bulkData.view = specs.view;
      if (specs.finishingType) bulkData.finishingType = specs.finishingType;
      if (specs.gardenArea !== undefined && specs.gardenArea !== "") bulkData.gardenArea = parseFloat(specs.gardenArea);
      if (specs.planImage) bulkData.planImage = specs.planImage;
      if (specs.status) bulkData.status = specs.status;

      const hasArea = specs.area !== undefined && specs.area !== "";
      const hasPpm = specs.pricePerMeter !== undefined && specs.pricePerMeter !== "";

      if (hasArea) bulkData.area = parseFloat(specs.area);
      if (hasPpm) bulkData.pricePerMeter = parseFloat(specs.pricePerMeter);

      if (hasArea && hasPpm) {
        bulkData.totalPrice = parseFloat(specs.area) * parseFloat(specs.pricePerMeter);
      }

      // Update all selected units
      const updateResult = await prisma.unit.updateMany({
        where: { id: { in: unitIds } },
        data: bulkData
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "Unit",
        details: `تعديل مجمع لـ ${updateResult.count} وحدة بالمواصفات والأسعار المحدثة دفعة واحدة`,
        newValues: { updatedCount: updateResult.count, appliedSpecs: specs },
        severity: "warning"
      });

      return new Response(JSON.stringify({
        success: true,
        updatedCount: updateResult.count,
        message: `تم تحديث مواصفات وتسعير ${updateResult.count} شقة بنجاح ⚡`
      }), { status: 200 });
    }

    // 3.3 Update Unit Status (تحديث حالة الوحدة: متاح، محجوز، مباع)
    if (body.action === "update_unit_status") {
      const { unitId, status } = body;
      if (!unitId || !status) {
        return new Response(JSON.stringify({ error: "معرف الوحدة والحالة مطلوبان" }), { status: 400 });
      }

      const oldUnit = await prisma.unit.findUnique({ where: { id: unitId } });

      const unit = await prisma.unit.update({
        where: { id: unitId },
        data: { status }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "Unit",
        entityId: unitId,
        details: `تحديث حالة الوحدة (${unit.unitNumber}) من [${oldUnit?.status || '-'}] إلى [${status}]`,
        oldValues: { status: oldUnit?.status },
        newValues: { status }
      });

      return new Response(JSON.stringify({ success: true, unit }), { status: 200 });
    }

    // 3.4 Delete Unit
    if (body.action === "delete_unit") {
      const { unitId } = body;
      if (!unitId) {
        return new Response(JSON.stringify({ error: "معرف الوحدة مطلوب" }), { status: 400 });
      }

      const oldUnit = await prisma.unit.findUnique({ where: { id: unitId } });

      await prisma.unit.delete({
        where: { id: unitId }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "DELETE",
        entity: "Unit",
        entityId: unitId,
        details: `حذف الوحدة (${oldUnit?.unitNumber || unitId}) وسجلها نهائياً`,
        oldValues: oldUnit ? {
          unitNumber: oldUnit.unitNumber,
          unitType: oldUnit.unitType,
          totalPrice: oldUnit.totalPrice,
          status: oldUnit.status
        } : null,
        severity: "critical"
      });

      return new Response(JSON.stringify({ success: true, message: "تم حذف الوحدة بنجاح" }), { status: 200 });
    }

    // 4. Add Payment Plan (أنظمة السداد)
    if (body.action === "add_payment_plan") {
      const { projectId, name, downPaymentPercent, installmentYears, installmentFrequency, discountPercent, description } = body;
      if (!projectId || !name || downPaymentPercent === undefined || !installmentYears) {
        return new Response(JSON.stringify({ error: "بيانات نظام السداد غير مكتملة" }), { status: 400 });
      }

      const plan = await prisma.paymentPlan.create({
        data: {
          projectId,
          name: name.trim(),
          downPaymentPercent: parseFloat(downPaymentPercent),
          installmentYears: parseInt(installmentYears),
          installmentFrequency: installmentFrequency || "monthly",
          discountPercent: discountPercent ? parseFloat(discountPercent) : 0,
          description: description?.trim() || null
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "CREATE",
        entity: "PaymentPlan",
        entityId: plan.id,
        details: `إنشاء نظام سداد جديد: (${plan.name}) لمشروع #${projectId} بمقدم ${plan.downPaymentPercent}% على ${plan.installmentYears} سنوات`,
        newValues: {
          name: plan.name,
          downPaymentPercent: plan.downPaymentPercent,
          installmentYears: plan.installmentYears,
          installmentFrequency: plan.installmentFrequency
        }
      });

      return new Response(JSON.stringify({ success: true, plan }), { status: 201 });
    }

    // 5. Update Project (تعديل بيانات المشروع)
    if (body.action === "update_project") {
      const {
        projectId,
        projectName,
        projectCode,
        projectType,
        maintenancePercentage,
        projectAddress,
        locationCoordinates,
        totalArea,
        startDate,
        expectedEndDate,
        status
      } = body;
      if (!projectId || !projectName) {
        return new Response(JSON.stringify({ error: "معرف المشروع واسم المشروع مطلوبان" }), { status: 400 });
      }

      const oldProject = await prisma.project.findUnique({ where: { id: projectId } });

      const updateData = {
        projectName: projectName.trim(),
        projectCode: projectCode ? projectCode.trim() : null,
        projectType: projectType ? projectType.trim() : null,
        maintenancePercentage: maintenancePercentage !== undefined && maintenancePercentage !== "" ? parseFloat(maintenancePercentage) : null,
        projectAddress: projectAddress ? projectAddress.trim() : null,
        locationCoordinates: locationCoordinates ? locationCoordinates.trim() : null,
        totalArea: totalArea !== undefined && totalArea !== "" ? parseFloat(totalArea) : null,
        startDate: startDate ? new Date(startDate) : null,
        expectedEndDate: expectedEndDate ? new Date(expectedEndDate) : null,
      };
      if (status) {
        updateData.status = status;
      }

      // Update assigned staff (Sales, Engineers, Accountants)
      if (Array.isArray(body.assignedUserIds)) {
        await prisma.salesProjectAssignment.deleteMany({
          where: { projectId }
        });

        for (const uid of body.assignedUserIds) {
          if (uid && typeof uid === 'string') {
            await prisma.salesProjectAssignment.create({
              data: {
                projectId,
                userId: uid
              }
            }).catch(() => null);
          }
        }
      }

      const project = await prisma.project.update({
        where: { id: projectId },
        data: updateData,
        include: {
          salesAssignments: { include: { user: { select: { id: true, name: true, role: true, email: true } } } }
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "UPDATE",
        entity: "Project",
        entityId: projectId,
        details: `تحديث بيانات المشروع وفريق العمل: ${project.projectName}`,
        oldValues: oldProject ? {
          projectName: oldProject.projectName,
          projectCode: oldProject.projectCode,
          status: oldProject.status
        } : null,
        newValues: {
          projectName: project.projectName,
          projectCode: project.projectCode,
          status: project.status
        }
      });

      return new Response(JSON.stringify({
        success: true,
        project,
        message: "تم تحديث بيانات المشروع وفريق العمل بنجاح"
      }), { status: 200 });
    }

    // 6. Archive / Restore Project (أرشفة أو استعادة المشروع)
    if (body.action === "archive_project") {
      const { projectId, archived } = body;
      if (!projectId) {
        return new Response(JSON.stringify({ error: "معرف المشروع مطلوب" }), { status: 400 });
      }

      const shouldArchive = archived !== undefined ? Boolean(archived) : true;
      const project = await prisma.project.update({
        where: { id: projectId },
        data: {
          archived: shouldArchive,
          status: shouldArchive ? "archived" : "under_development"
        }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: shouldArchive ? "ARCHIVE" : "RESTORE",
        entity: "Project",
        entityId: projectId,
        details: shouldArchive
          ? `أرشفة المشروع الاستثماري (${project.projectName}) وتعطيل العمليات عليه`
          : `استعادة المشروع الاستثماري (${project.projectName}) من الأرشيف وتفعيله`,
        newValues: { archived: shouldArchive, status: project.status },
        severity: "critical"
      });

      return new Response(JSON.stringify({
        success: true,
        project,
        message: shouldArchive ? "تمت أرشفة المشروع بنجاح" : "تم استعادة المشروع من الأرشيف بنجاح"
      }), { status: 200 });
    }

    // 7. Delete Project (حذف المشروع نهائياً)
    if (body.action === "delete_project") {
      const { projectId } = body;
      if (!projectId) {
        return new Response(JSON.stringify({ error: "معرف المشروع مطلوب" }), { status: 400 });
      }

      // Check if project exists and is archived
      const existingProject = await prisma.project.findUnique({
        where: { id: projectId }
      });

      if (!existingProject) {
        return new Response(JSON.stringify({ error: "المشروع غير موجود" }), { status: 404 });
      }

      if (!existingProject.archived) {
        return new Response(JSON.stringify({
          error: "لا يمكن حذف المشروع إلا بعد أرشفته أولاً."
        }), { status: 400 });
      }

      // Check for existing reservations
      const reservationsCount = await prisma.reservation.count({
        where: { projectId }
      });

      if (reservationsCount > 0) {
        return new Response(JSON.stringify({
          error: "لا يمكن حذف المشروع لوجود تعاقدات أو حجوزات نشطة مرتبطة به. يرجى أرشفة المشروع بدلاً من حذفه للحفاظ على القيود المحاسبية والتعاقدية."
        }), { status: 400 });
      }

      // Handle project treasuries safely
      const treasuries = await prisma.treasury.findMany({ where: { projectId } });
      for (const tr of treasuries) {
        const txCount = await prisma.transaction.count({ where: { treasuryId: tr.id } });
        if (txCount === 0) {
          await prisma.treasury.delete({ where: { id: tr.id } });
        } else {
          await prisma.treasury.update({ where: { id: tr.id }, data: { projectId: null } });
        }
      }

      // Delete project (cascade removes units, buildings, payment plans, stages, etc.)
      await prisma.project.delete({
        where: { id: projectId }
      });

      await createAuditLog({
        request,
        userId: user.userId,
        userName: user.name,
        userRole: user.role,
        action: "DELETE",
        entity: "Project",
        entityId: projectId,
        details: `حذف المشروع (${existingProject.projectName}) نهائياً بكافة مكوناته بعد أرشفته`,
        oldValues: {
          projectName: existingProject.projectName,
          projectCode: existingProject.projectCode
        },
        severity: "critical"
      });

      return new Response(JSON.stringify({
        success: true,
        message: "تم حذف المشروع وجميع مكوناته بنجاح"
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "إجراء غير معروف" }), { status: 400 });
  } catch (error) {
    console.error("Development API POST error:", error);
    return new Response(JSON.stringify({ error: "فشل تنفيذ العملية" }), { status: 500 });
  }
}

export async function DELETE({ request }) {
  try {
    const user = getAuthenticatedUser(request);
    if (!user || user.role !== "admin") {
      return new Response(JSON.stringify({ error: "صلاحية الأدمن مطلوبة" }), { status: 403 });
    }

    const url = new URL(request.url);
    let projectId = url.searchParams.get("projectId");

    if (!projectId) {
      const body = await request.json().catch(() => null);
      projectId = body?.projectId;
    }

    if (!projectId) {
      return new Response(JSON.stringify({ error: "معرف المشروع مطلوب" }), { status: 400 });
    }

    const existingProject = await prisma.project.findUnique({
      where: { id: projectId }
    });

    if (!existingProject) {
      return new Response(JSON.stringify({ error: "المشروع غير موجود" }), { status: 404 });
    }

    if (!existingProject.archived) {
      return new Response(JSON.stringify({
        error: "لا يمكن حذف المشروع إلا بعد أرشفته أولاً."
      }), { status: 400 });
    }

    const reservationsCount = await prisma.reservation.count({
      where: { projectId }
    });

    if (reservationsCount > 0) {
      return new Response(JSON.stringify({
        error: "لا يمكن حذف هذا المشروع لوجود حجوزات أو تعاقدات نشطة مرتبطة به. يرجى أرشفته بدلاً من حذفه."
      }), { status: 400 });
    }

    const treasuries = await prisma.treasury.findMany({ where: { projectId } });
    for (const tr of treasuries) {
      const txCount = await prisma.transaction.count({ where: { treasuryId: tr.id } });
      if (txCount === 0) {
        await prisma.treasury.delete({ where: { id: tr.id } });
      } else {
        await prisma.treasury.update({ where: { id: tr.id }, data: { projectId: null } });
      }
    }

    await prisma.project.delete({
      where: { id: projectId }
    });

    await createAuditLog({
      request,
      userId: user.userId,
      userName: user.name,
      userRole: user.role,
      action: "DELETE",
      entity: "Project",
      entityId: projectId,
      details: `حذف المشروع (${existingProject.projectName}) عبر DELETE method نهائياً`,
      oldValues: {
        projectName: existingProject.projectName,
        projectCode: existingProject.projectCode
      },
      severity: "critical"
    });

    return new Response(JSON.stringify({
      success: true,
      message: "تم حذف المشروع بنجاح"
    }), { status: 200 });
  } catch (error) {
    console.error("Development API DELETE error:", error);
    return new Response(JSON.stringify({ error: "فشل حذف المشروع" }), { status: 500 });
  }
}
