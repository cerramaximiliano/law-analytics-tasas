// server/services/stats/statsAnalysisService.js
const mongoose = require('mongoose');
const moment = require('moment');
const logger = require('../../utils/logger');

// Importar modelos
const UserAnalytics = require('../../models/UserAnalytics');
// Nota: No necesitamos importar directamente los otros modelos,
// usaremos mongoose.connection.collection para acceder a las colecciones

// Constantes
const COLLECTIONS = {
    users: 'usuarios',
    stats: 'userstats',
    analytics: 'useranalytics',
    calculators: 'calculators',
    folders: 'folders',
    movements: 'movements',
    notifications: 'notifications',
    events: 'events',
    contacts: 'contacts',
    tasks: 'tasks',
    alerts: 'alerts'
};

/**
 * Genera analíticas completas para un usuario específico
 * @param {string} userId - ID del usuario
 * @returns {Promise<Object>} - Resultado de la operación
 */
async function generateUserAnalytics(userId) {
    try {
        if (!userId) {
            logger.warn('Se intentó generar analíticas sin proporcionar userId');
            return { success: false, error: 'userId requerido' };
        }

        // Verificar conexión a MongoDB
        if (mongoose.connection.readyState !== 1) {
            logger.error('No hay conexión a MongoDB para generar analíticas');
            return { success: false, error: 'Sin conexión a la base de datos' };
        }

        // Convertir userId a ObjectId si es necesario
        const userIdObj = typeof userId === 'string'
            ? new mongoose.Types.ObjectId(userId)
            : userId;

        // Verificar si el usuario existe
        const usersCollection = mongoose.connection.collection(COLLECTIONS.users);
        const userExists = await usersCollection.findOne({ _id: userIdObj });

        if (!userExists) {
            logger.warn(`Usuario con ID ${userId} no encontrado para generar analíticas`);
            return { success: false, error: 'Usuario no encontrado' };
        }

        logger.info(`Generando analíticas para usuario ${userId}`);

        // Realizar análisis en paralelo para mejorar rendimiento
        const [
            folderStats,
            financialStats,
            activityStats,
            taskStats,
            notificationStats,
            trendData,
            matterStats
        ] = await Promise.all([
            generateFolderStatusAnalytics(userIdObj),
            generateFinancialAnalytics(userIdObj),
            generateActivityAnalytics(userIdObj),
            generateTaskAnalytics(userIdObj),
            generateNotificationAnalytics(userIdObj),
            generateTrendAnalytics(userIdObj),
            generateMatterAnalytics(userIdObj)
        ]);

        // Construir el objeto completo de analíticas
        const analytics = {
            userId: userIdObj,
            folderStatusDistribution: folderStats.distribution,
            averageResolutionTimes: folderStats.resolutionTimes,
            upcomingDeadlines: folderStats.deadlines,
            activityMetrics: activityStats,
            financialMetrics: financialStats,
            matterDistribution: matterStats.distribution,
            averageAmountByMatter: matterStats.averageAmount,
            resolutionTimeByMatter: matterStats.resolutionTime,
            taskMetrics: taskStats,
            notificationMetrics: notificationStats,
            trendData: trendData,
            lastUpdated: new Date(),
            dataQuality: calculateDataQuality(folderStats, financialStats, activityStats),
            analyticsVersion: '1.0'
        };

        // Crear nuevo documento en la base de datos (no actualizar)
        await UserAnalytics.create(analytics);

        logger.info(`Analíticas generadas y guardadas para usuario ${userId}`);
        return { success: true, analytics };
    } catch (error) {
        logger.error(`Error al generar analíticas para usuario ${userId}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Genera estadísticas de estado de carpetas
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Estadísticas de carpetas
 */
async function generateFolderStatusAnalytics(userId) {
    try {
        const foldersCollection = mongoose.connection.collection(COLLECTIONS.folders);

        const uniqueStatuses = await foldersCollection.distinct('status', { userId: userId });
        logger.info(`Estados de carpeta encontrados para usuario ${userId}: ${JSON.stringify(uniqueStatuses)}`);

        // 1. Obtener distribución de carpetas por estado (solo activas, no archivadas)
        const statusAggregation = await foldersCollection.aggregate([
            { $match: { userId: userId, archived: { $ne: true } } },
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            }
        ]).toArray();

        // Transformar resultado a un objeto
        const distribution = {
            nueva: 0,
            enProceso: 0,
            cerrada: 0,
            pendiente: 0
        };

        statusAggregation.forEach(item => {
            if (!item._id) return;

            const statusUpper = item._id.toUpperCase();
            if (statusUpper === 'NUEVA') {
                distribution.nueva = item.count;
            } else if (statusUpper === 'EN PROCESO') {
                distribution.enProceso = item.count;
            } else if (statusUpper === 'CERRADA') {
                distribution.cerrada = item.count;
            } else if (statusUpper === 'PENDIENTE') {
                distribution.pendiente = item.count;
            }
        });

        // 2. Calcular tiempos de resolución
        const now = new Date();
        const resolutionTimes = {
            overall: 0,
            byStatus: {
                nueva: 0,
                enProceso: 0,
                pendiente: 0
            }
        };

        // Obtener todas las carpetas activas (no archivadas)
        const folders = await foldersCollection.find({ userId: userId, archived: { $ne: true } }).toArray();

        // Calcular tiempos promedio por estado
        if (folders.length > 0) {
            let totalDays = 0;
            let totalFolders = 0;

            const statusCounts = { nueva: 0, enProceso: 0, pendiente: 0 };
            const statusDays = { nueva: 0, enProceso: 0, pendiente: 0 };

            folders.forEach(folder => {
                const createdAt = folder.createdAt || folder.initialDateFolder;

                if (createdAt) {
                    const createdDate = new Date(createdAt);
                    // La comparación también debe ser más robusta
                    const endDate = folder.status && folder.status.toUpperCase() === 'CERRADA' && folder.finalDateFolder
                        ? new Date(folder.finalDateFolder)
                        : now;

                    const daysActive = Math.ceil((endDate - createdDate) / (1000 * 60 * 60 * 24));

                    if (daysActive >= 0) {
                        totalDays += daysActive;
                        totalFolders++;

                        // Aquí también normalizar correctamente
                        const statusUpper = folder.status ? folder.status.toUpperCase() : '';
                        if (statusUpper === 'NUEVA') {
                            statusCounts.nueva++;
                            statusDays.nueva += daysActive;
                        } else if (statusUpper === 'EN PROCESO') {
                            statusCounts.enProceso++;
                            statusDays.enProceso += daysActive;
                        } else if (statusUpper === 'PENDIENTE') {
                            statusCounts.pendiente++;
                            statusDays.pendiente += daysActive;
                        }
                    }
                }
            });

            // Calcular promedios
            resolutionTimes.overall = totalFolders > 0 ? Math.round(totalDays / totalFolders) : 0;

            for (const status in statusCounts) {
                resolutionTimes.byStatus[status] = statusCounts[status] > 0
                    ? Math.round(statusDays[status] / statusCounts[status])
                    : 0;
            }
        }

        // 3. Calcular plazos próximos a vencer
        const deadlines = {
            next7Days: 0,
            next15Days: 0,
            next30Days: 0
        };

        // Considerar eventos próximos y movimientos con fechas de expiración
        const eventsCollection = mongoose.connection.collection(COLLECTIONS.events);
        const movementsCollection = mongoose.connection.collection(COLLECTIONS.movements);

        const next7Days = moment().add(7, 'days').toDate();
        const next15Days = moment().add(15, 'days').toDate();
        const next30Days = moment().add(30, 'days').toDate();

        // Contar eventos próximos
        const [events7, events15, events30] = await Promise.all([
            eventsCollection.countDocuments({
                userId: userId,
                end: { $gte: new Date(), $lte: next7Days }
            }),
            eventsCollection.countDocuments({
                userId: userId,
                end: { $gte: new Date(), $lte: next15Days }
            }),
            eventsCollection.countDocuments({
                userId: userId,
                end: { $gte: new Date(), $lte: next30Days }
            })
        ]);

        // Contar movimientos con fechas de expiración
        const [movements7, movements15, movements30] = await Promise.all([
            movementsCollection.countDocuments({
                userId: userId,
                dateExpiration: {
                    $exists: true,
                    $ne: null,
                    $ne: ''
                },
                time: {
                    $gte: moment().format('YYYY-MM-DD'),
                    $lte: moment().add(7, 'days').format('YYYY-MM-DD')
                }
            }),
            movementsCollection.countDocuments({
                userId: userId,
                dateExpiration: {
                    $exists: true,
                    $ne: null,
                    $ne: ''
                },
                time: {
                    $gte: moment().format('YYYY-MM-DD'),
                    $lte: moment().add(15, 'days').format('YYYY-MM-DD')
                }
            }),
            movementsCollection.countDocuments({
                userId: userId,
                dateExpiration: {
                    $exists: true,
                    $ne: null,
                    $ne: ''
                },
                time: {
                    $gte: moment().format('YYYY-MM-DD'),
                    $lte: moment().add(30, 'days').format('YYYY-MM-DD')
                }
            })
        ]);

        deadlines.next7Days = events7 + movements7;
        deadlines.next15Days = events15 + movements15;
        deadlines.next30Days = events30 + movements30;

        return {
            distribution,
            resolutionTimes,
            deadlines
        };
    } catch (error) {
        logger.error(`Error al generar estadísticas de carpetas: ${error.message}`);
        return {
            distribution: { nueva: 0, enProceso: 0, cerrada: 0, pendiente: 0 },
            resolutionTimes: { overall: 0, byStatus: { nueva: 0, enProceso: 0, pendiente: 0 } },
            deadlines: { next7Days: 0, next15Days: 0, next30Days: 0 }
        };
    }
}

/**
 * Genera estadísticas financieras
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Estadísticas financieras
 */
async function generateFinancialAnalytics(userId) {
    try {
        const foldersCollection = mongoose.connection.collection(COLLECTIONS.folders);
        const calculatorsCollection = mongoose.connection.collection(COLLECTIONS.calculators);

        // 1. Obtener montos totales y promedios de carpetas (solo activas, no archivadas)
        const folderAmounts = await foldersCollection.aggregate([
            { $match: { userId: userId, archived: { $ne: true } } },
            {
                $group: {
                    _id: '$status',
                    totalAmount: { $sum: { $ifNull: ['$amount', 0] } },
                    count: { $sum: 1 }
                }
            }
        ]).toArray();

        // Inicializar objeto de resultados
        const financialStats = {
            totalActiveAmount: 0,
            averageAmountPerFolder: 0,
            amountByStatus: {
                nueva: 0,
                enProceso: 0,
                cerrada: 0,
                pendiente: 0
            },
            calculatorsByType: {
                calculado: 0,
                ofertado: 0,
                reclamado: 0
            },
            calculatorsAmountByType: {
                calculado: 0,
                ofertado: 0,
                reclamado: 0
            }
        };

        // Procesar montos por estado
        let totalAmount = 0;
        let totalFolders = 0;

        folderAmounts.forEach(item => {
            const status = item._id.toLowerCase().replace(' ', '');
            if (financialStats.amountByStatus.hasOwnProperty(status)) {
                financialStats.amountByStatus[status] = item.totalAmount || 0;

                // Sumar al total activo si no está cerrada
                if (status !== 'cerrada') {
                    financialStats.totalActiveAmount += item.totalAmount || 0;
                }

                totalAmount += item.totalAmount || 0;
                totalFolders += item.count || 0;
            }
        });

        // Calcular promedio general
        financialStats.averageAmountPerFolder = totalFolders > 0
            ? Math.round(totalAmount / totalFolders)
            : 0;

        // 2. Obtener estadísticas de calculadoras (solo activas, no archivadas)
        // Nota: Se incluyen todos los tipos (calculado, ofertado, reclamado) para analíticas financieras completas
        const calculatorStats = await calculatorsCollection.aggregate([
            { $match: { userId: userId, archived: { $ne: true } } },
            {
                $group: {
                    _id: { $toLower: '$type' },
                    count: { $sum: 1 },
                    totalAmount: { $sum: { $ifNull: ['$amount', 0] } }
                }
            }
        ]).toArray();

        // Procesar estadísticas de calculadoras
        calculatorStats.forEach(item => {
            const type = item._id.toLowerCase();
            if (financialStats.calculatorsByType.hasOwnProperty(type)) {
                financialStats.calculatorsByType[type] = item.count || 0;
                financialStats.calculatorsAmountByType[type] = item.totalAmount || 0;
            }
        });

        return financialStats;
    } catch (error) {
        logger.error(`Error al generar estadísticas financieras: ${error.message}`);
        return {
            totalActiveAmount: 0,
            averageAmountPerFolder: 0,
            amountByStatus: { nueva: 0, enProceso: 0, cerrada: 0, pendiente: 0 },
            calculatorsByType: { calculado: 0, ofertado: 0, reclamado: 0 },
            calculatorsAmountByType: { calculado: 0, ofertado: 0, reclamado: 0 }
        };
    }
}

/**
 * Genera estadísticas de actividad
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Estadísticas de actividad
 */
async function generateActivityAnalytics(userId) {
    try {
        const movementsCollection = mongoose.connection.collection(COLLECTIONS.movements);

        // Obtener fecha hace 30 días
        const thirtyDaysAgo = moment().subtract(30, 'days').toDate();

        // Buscar todos los movimientos de los últimos 30 días
        const movements = await movementsCollection.find({
            userId: userId,
            createdAt: { $gte: thirtyDaysAgo }
        }).toArray();

        // Inicializar estadísticas de actividad
        const activityStats = {
            dailyAverage: 0,
            weeklyAverage: 0,
            monthlyAverage: 0,
            mostActiveDay: 'N/A'
        };

        if (movements.length > 0) {
            // Calcular promedios
            activityStats.monthlyAverage = movements.length;
            activityStats.weeklyAverage = Math.round(movements.length / 4); // Aproximado
            activityStats.dailyAverage = Math.round(movements.length / 30);

            // Determinar día más activo
            const dayCount = {
                'Monday': 0,
                'Tuesday': 0,
                'Wednesday': 0,
                'Thursday': 0,
                'Friday': 0,
                'Saturday': 0,
                'Sunday': 0
            };

            movements.forEach(movement => {
                if (movement.createdAt) {
                    const dayOfWeek = moment(movement.createdAt).format('dddd');
                    if (dayCount.hasOwnProperty(dayOfWeek)) {
                        dayCount[dayOfWeek]++;
                    }
                }
            });

            // Encontrar el día más activo
            let maxCount = 0;
            for (const day in dayCount) {
                if (dayCount[day] > maxCount) {
                    maxCount = dayCount[day];
                    activityStats.mostActiveDay = day;
                }
            }
        }

        return activityStats;
    } catch (error) {
        logger.error(`Error al generar estadísticas de actividad: ${error.message}`);
        return {
            dailyAverage: 0,
            weeklyAverage: 0,
            monthlyAverage: 0,
            mostActiveDay: 'N/A'
        };
    }
}

/**
 * Genera estadísticas de tareas
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Estadísticas de tareas
 */
async function generateTaskAnalytics(userId) {
    try {
        const tasksCollection = mongoose.connection.collection(COLLECTIONS.tasks);

        // Buscar todas las tareas del usuario
        // Convertir userId a string ya que las tareas lo guardan como string
        const userIdString = userId.toString();
        const tasks = await tasksCollection.find({
            $or: [
                { userId: userId },        // Buscar como ObjectId
                { userId: userIdString }   // Buscar como string
            ]
        }).toArray();

        // Inicializar estadísticas de tareas
        const taskStats = {
            completionRate: 0,
            pendingTasks: 0,
            completedTasks: 0,
            overdueTasks: 0,
            priorityDistribution: {
                alta: 0,
                media: 0,
                baja: 0
            },
            statusDistribution: {
                pendiente: 0,
                en_progreso: 0,
                revision: 0,
                completada: 0,
                cancelada: 0
            },
            tasksWithSubtasks: 0,
            tasksWithAttachments: 0,
            tasksWithComments: 0,
            averageSubtasksPerTask: 0,
            totalSubtasks: 0,
            completedSubtasks: 0,
            subtaskCompletionRate: 0
        };

        if (tasks.length > 0) {
            let totalSubtasks = 0;
            let completedSubtasks = 0;

            // Contar tareas completadas y pendientes
            tasks.forEach(task => {
                // Estado de completitud basado en checked o status
                if (task.checked || task.status === 'completada' || task.status === 'cancelada') {
                    taskStats.completedTasks++;
                } else {
                    taskStats.pendingTasks++;

                    // Verificar si está vencida usando dueDate en lugar de date
                    if (task.dueDate && new Date(task.dueDate) < new Date()) {
                        taskStats.overdueTasks++;
                    }
                }

                // Estadísticas de prioridad
                if (task.priority) {
                    taskStats.priorityDistribution[task.priority]++;
                } else {
                    // Si no tiene prioridad asignada, asumimos que es media (valor por defecto)
                    taskStats.priorityDistribution.media++;
                }

                // Estadísticas de estado
                if (task.status) {
                    taskStats.statusDistribution[task.status]++;
                } else {
                    // Si no tiene estado asignado, asumimos que es pendiente (valor por defecto)
                    taskStats.statusDistribution.pendiente++;
                }

                // Estadísticas de subtareas
                if (task.subtasks && task.subtasks.length > 0) {
                    taskStats.tasksWithSubtasks++;
                    totalSubtasks += task.subtasks.length;

                    // Contar subtareas completadas
                    task.subtasks.forEach(subtask => {
                        if (subtask.completed) {
                            completedSubtasks++;
                        }
                    });
                }

                // Estadísticas de archivos adjuntos
                if (task.attachments && task.attachments.length > 0) {
                    taskStats.tasksWithAttachments++;
                }

                // Estadísticas de comentarios
                if (task.comments && task.comments.length > 0) {
                    taskStats.tasksWithComments++;
                }
            });

            // Calcular tasa de completitud
            taskStats.completionRate = Math.round(
                (taskStats.completedTasks / tasks.length) * 100
            );

            // Calcular estadísticas de subtareas
            taskStats.totalSubtasks = totalSubtasks;
            taskStats.completedSubtasks = completedSubtasks;
            taskStats.averageSubtasksPerTask = totalSubtasks > 0 ?
                parseFloat((totalSubtasks / tasks.length).toFixed(1)) : 0;
            taskStats.subtaskCompletionRate = totalSubtasks > 0 ?
                Math.round((completedSubtasks / totalSubtasks) * 100) : 0;
        }

        return taskStats;
    } catch (error) {
        logger.error(`Error al generar estadísticas de tareas: ${error.message}`);
        return {
            completionRate: 0,
            pendingTasks: 0,
            completedTasks: 0,
            overdueTasks: 0,
            priorityDistribution: {
                alta: 0,
                media: 0,
                baja: 0
            },
            statusDistribution: {
                pendiente: 0,
                en_progreso: 0,
                revision: 0,
                completada: 0,
                cancelada: 0
            },
            tasksWithSubtasks: 0,
            tasksWithAttachments: 0,
            tasksWithComments: 0,
            averageSubtasksPerTask: 0,
            totalSubtasks: 0,
            completedSubtasks: 0,
            subtaskCompletionRate: 0
        };
    }
}

/**
 * Genera estadísticas de notificaciones
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Estadísticas de notificaciones
 */
async function generateNotificationAnalytics(userId) {
    try {
        const alertsCollection = mongoose.connection.collection(COLLECTIONS.alerts);

        // Buscar alertas del usuario
        // Buscar userId tanto como ObjectId como string para compatibilidad
        const alerts = await alertsCollection.find({
            $or: [
                { userId: userId },           // Buscar como ObjectId
                { userId: userId.toString() } // Buscar como string
            ]
        }).toArray();

        // Inicializar estadísticas de notificaciones
        const notificationStats = {
            totalCount: 0,
            unreadCount: 0,
            averageReadTime: 0,
            responseRate: 0
        };

        if (alerts.length > 0) {
            // Total de alertas
            notificationStats.totalCount = alerts.length;

            // Contar alertas no leídas y calcular tiempos
            let totalReadTime = 0;
            let readAlerts = 0;

            alerts.forEach(alert => {
                // Usar 'read' en lugar de 'isRead' según el modelo
                if (!alert.read) {
                    notificationStats.unreadCount++;
                } else if (alert.updatedAt && alert.createdAt) {
                    // Calcular tiempo de lectura en horas
                    // Usar updatedAt como momento de lectura ya que no hay campo viewedAt
                    const createdAt = new Date(alert.createdAt);
                    const readAt = new Date(alert.updatedAt);
                    const readTimeHours = (readAt - createdAt) / (1000 * 60 * 60);

                    // Solo considerar tiempos razonables (menos de 7 días)
                    if (readTimeHours >= 0 && readTimeHours < 168) {
                        totalReadTime += readTimeHours;
                        readAlerts++;
                    }
                }
            });

            // Calcular tiempo promedio de lectura
            notificationStats.averageReadTime = readAlerts > 0
                ? Math.round(totalReadTime / readAlerts * 10) / 10
                : 0;

            // Calcular tasa de respuesta (porcentaje de alertas leídas)
            const readCount = alerts.length - notificationStats.unreadCount;
            // Mostrar porcentaje exacto con 2 decimales
            notificationStats.responseRate = parseFloat(
                ((readCount / alerts.length) * 100).toFixed(2)
            );
        }

        return notificationStats;
    } catch (error) {
        logger.error(`Error al generar estadísticas de notificaciones: ${error.message}`);
        return {
            totalCount: 0,
            unreadCount: 0,
            averageReadTime: 0,
            responseRate: 0
        };
    }
}

/**
 * Genera análisis de tendencias por mes
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Datos de tendencias
 */
async function generateTrendAnalytics(userId) {
    try {
        // Obtener fecha hace 6 meses
        const sixMonthsAgo = moment().subtract(6, 'months').startOf('month');

        const foldersCollection = mongoose.connection.collection(COLLECTIONS.folders);
        const movementsCollection = mongoose.connection.collection(COLLECTIONS.movements);
        const calculatorsCollection = mongoose.connection.collection(COLLECTIONS.calculators);
        const tasksCollection = mongoose.connection.collection(COLLECTIONS.tasks);

        // Obtener todas las carpetas, movimientos, calculadoras y tareas de los últimos 6 meses
        // Solo se incluyen recursos activos (no archivados) para consistencia con UserStats
        const [folders, movements, calculators, tasks] = await Promise.all([
            foldersCollection.find({
                userId: userId,
                archived: { $ne: true },
                createdAt: { $gte: sixMonthsAgo.toDate() }
            }).toArray(),
            movementsCollection.find({
                userId: userId,
                createdAt: { $gte: sixMonthsAgo.toDate() }
            }).toArray(),
            calculatorsCollection.find({
                userId: userId,
                archived: { $ne: true },
                createdAt: { $gte: sixMonthsAgo.toDate() }
            }).toArray(),
            tasksCollection.find({
                $or: [
                    { userId: userId, createdAt: { $gte: sixMonthsAgo.toDate() } },        // Como ObjectId
                    { userId: userId.toString(), createdAt: { $gte: sixMonthsAgo.toDate() } }   // Como string
                ]
            }).toArray()
        ]);

        // Inicializar datos de tendencias
        const trendData = {
            newFolders: [],
            closedFolders: [],
            movements: [],
            calculators: [],
            tasks: []
        };

        // Preparar meses para tendencias
        for (let i = 0; i < 6; i++) {
            const monthStr = moment().subtract(i, 'months').format('YYYY-MM');

            trendData.newFolders.push({ month: monthStr, count: 0 });
            trendData.closedFolders.push({ month: monthStr, count: 0 });
            trendData.movements.push({ month: monthStr, count: 0 });
            trendData.calculators.push({ month: monthStr, count: 0 });
            trendData.tasks.push({ month: monthStr, count: 0 });
        }

        // Función para incrementar el contador del mes adecuado
        const incrementMonthCount = (array, date) => {
            const monthStr = moment(date).format('YYYY-MM');
            const monthData = array.find(item => item.month === monthStr);
            if (monthData) {
                monthData.count++;
            }
        };

        // Procesar datos para tendencias
        folders.forEach(folder => {
            if (folder.createdAt) {
                incrementMonthCount(trendData.newFolders, folder.createdAt);
            }

            if (folder.status === 'Cerrada' && folder.finalDateFolder) {
                incrementMonthCount(trendData.closedFolders, folder.finalDateFolder);
            }
        });

        movements.forEach(movement => {
            if (movement.createdAt) {
                incrementMonthCount(trendData.movements, movement.createdAt);
            }
        });

        calculators.forEach(calculator => {
            if (calculator.createdAt) {
                incrementMonthCount(trendData.calculators, calculator.createdAt);
            }
        });

        tasks.forEach(task => {
            if (task.createdAt) {
                incrementMonthCount(trendData.tasks, task.createdAt);
            }
        });

        // Invertir los arrays para que el mes más reciente esté primero
        trendData.newFolders.reverse();
        trendData.closedFolders.reverse();
        trendData.movements.reverse();
        trendData.calculators.reverse();
        trendData.tasks.reverse();

        return trendData;
    } catch (error) {
        logger.error(`Error al generar análisis de tendencias: ${error.message}`);
        return {
            newFolders: [],
            closedFolders: [],
            movements: [],
            calculators: [],
            tasks: []
        };
    }
}

/**
 * Genera estadísticas por materia
 * @param {ObjectId} userId - ID del usuario
 * @returns {Promise<Object>} - Estadísticas por materia
 */
async function generateMatterAnalytics(userId) {
    try {
        const foldersCollection = mongoose.connection.collection(COLLECTIONS.folders);

        // Obtener carpetas agrupadas por materia (normalizando a minúsculas y quitando espacios extra)
        // Solo carpetas activas (no archivadas)
        const matterStats = await foldersCollection.aggregate([
            { $match: { userId: userId, archived: { $ne: true } } },
            {
                $addFields: {
                    // Normalizar materia: convertir a minúsculas y quitar espacios extra
                    materiaOriginal: '$materia',
                    materiaNormalizada: {
                        $trim: {
                            input: { $toLower: { $ifNull: ['$materia', ''] } }
                        }
                    }
                }
            },
            {
                $group: {
                    _id: '$materiaNormalizada',
                    // Mantener la versión original más común para display
                    materiaDisplay: { $first: '$materiaOriginal' },
                    count: { $sum: 1 },
                    totalAmount: { $sum: { $ifNull: ['$amount', 0] } },
                    avgResolutionDays: {
                        $avg: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ['$initialDateFolder', null] },
                                        { $ne: ['$initialDateFolder', ''] },
                                        { $ne: ['$finalDateFolder', null] },
                                        { $ne: ['$finalDateFolder', ''] }
                                    ]
                                },
                                {
                                    $divide: [
                                        {
                                            $subtract: [
                                                { $dateFromString: {
                                                    dateString: '$finalDateFolder',
                                                    format: '%Y-%m-%d',
                                                    onError: null,
                                                    onNull: null
                                                } },
                                                { $dateFromString: {
                                                    dateString: '$initialDateFolder',
                                                    format: '%Y-%m-%d',
                                                    onError: null,
                                                    onNull: null
                                                } }
                                            ]
                                        },
                                        86400000 // milisegundos en un día
                                    ]
                                },
                                null
                            ]
                        }
                    }
                }
            }
        ]).toArray();

        // Inicializar objetos de resultado
        const distribution = new Map();
        const averageAmount = new Map();
        const resolutionTime = new Map();

        // Procesar resultados
        matterStats.forEach(stat => {
            if (stat._id && stat._id !== '') {
                // Usar la versión display (original) para mostrar, pero agrupados por la normalizada
                const materiaKey = stat.materiaDisplay || stat._id;

                // Capitalizar primera letra de cada palabra para consistencia visual
                const materiaFormateada = materiaKey
                    .toLowerCase()
                    .split(' ')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ');

                distribution.set(materiaFormateada, stat.count);

                // Calcular monto promedio por materia
                const avg = stat.count > 0 ? Math.round(stat.totalAmount / stat.count) : 0;
                averageAmount.set(materiaFormateada, avg);

                // Tiempo de resolución promedio (redondeado a días enteros)
                if (stat.avgResolutionDays) {
                    resolutionTime.set(materiaFormateada, Math.round(stat.avgResolutionDays));
                } else {
                    resolutionTime.set(materiaFormateada, 0);
                }
            }
        });

        return {
            distribution,
            averageAmount,
            resolutionTime
        };
    } catch (error) {
        logger.error(`Error al generar estadísticas por materia: ${error.message}`);
        return {
            distribution: new Map(),
            averageAmount: new Map(),
            resolutionTime: new Map()
        };
    }
}

/**
 * Calcula la calidad de los datos (completitud)
 * @param {Object} folderStats - Estadísticas de carpetas
 * @param {Object} financialStats - Estadísticas financieras
 * @param {Object} activityStats - Estadísticas de actividad
 * @returns {number} - Puntuación de calidad (0-100)
 */
function calculateDataQuality(folderStats, financialStats, activityStats) {
    // Iniciar con puntuación perfecta
    let qualityScore = 100;

    // Verificar datos de carpetas
    const totalFolders = Object.values(folderStats.distribution).reduce((a, b) => a + b, 0);
    if (totalFolders === 0) {
        qualityScore -= 30; // Sin carpetas, datos muy limitados
    }

    // Verificar datos financieros
    if (financialStats.totalActiveAmount === 0) {
        qualityScore -= 20; // Sin montos, datos financieros incompletos
    }

    // Verificar datos de actividad
    if (activityStats.monthlyAverage === 0) {
        qualityScore -= 20; // Sin actividad reciente, datos poco representativos
    }

    // Limitar el rango a 0-100
    return Math.max(0, Math.min(100, qualityScore));
}

/**
 * Genera analíticas para todos los usuarios
 * @returns {Promise<Object>} - Resultado de la operación
 */
async function generateAllUsersAnalytics() {
    try {
        const usersCollection = mongoose.connection.collection(COLLECTIONS.users);

        // Obtener todos los usuarios
        const users = await usersCollection.find({}).toArray();
        logger.info(`Generando analíticas para ${users.length} usuarios`);

        let successCount = 0;
        let errorCount = 0;

        // Procesar usuarios en lotes para no sobrecargar la base de datos
        const batchSize = 10;
        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);

            // Generar analíticas para cada usuario en el lote en paralelo
            const promises = batch.map(user => generateUserAnalytics(user._id.toString()));
            const results = await Promise.all(promises.map(p => p.catch(e => {
                logger.error(e);
                return { success: false };
            })));

            // Contar éxitos y fracasos
            successCount += results.filter(result => result.success === true).length;
            errorCount += results.filter(result => result.success === false).length;

            logger.info(`Procesado lote ${Math.floor(i / batchSize) + 1}/${Math.ceil(users.length / batchSize)}`);
        }

        logger.info(`Generación de analíticas completada. Éxitos: ${successCount}, Errores: ${errorCount}`);
        return { success: successCount, errors: errorCount };
    } catch (error) {
        logger.error(`Error al generar analíticas para todos los usuarios: ${error.message}`);
        return { success: 0, errors: 0, error: error.message };
    }
}

/**
 * Obtiene las analíticas del usuario
 * @param {string} userId - ID del usuario
 * @returns {Promise<Object>} - Analíticas del usuario
 */
async function getUserAnalytics(userId) {
    try {
        if (!userId) {
            logger.warn('Se intentó obtener analíticas sin proporcionar userId');
            return { success: false, error: 'userId requerido' };
        }

        // Convertir userId a ObjectId si es necesario
        const userIdObj = typeof userId === 'string'
            ? new mongoose.Types.ObjectId(userId)
            : userId;

        // Buscar analíticas existentes
        let analytics = await UserAnalytics.findOne({ userId: userIdObj });

        // Si no existen analíticas o están desactualizadas (más de 24 horas), generarlas
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (!analytics || !analytics.lastUpdated || analytics.lastUpdated < oneDayAgo) {
            logger.info(`Generando nuevas analíticas para usuario ${userId}`);
            const result = await generateUserAnalytics(userId);

            if (result.success) {
                analytics = await UserAnalytics.findOne({ userId: userIdObj });
            } else {
                return { success: false, error: 'Error al generar analíticas', details: result.error };
            }
        }

        return { success: true, analytics };
    } catch (error) {
        logger.error(`Error al obtener analíticas para usuario ${userId}: ${error.message}`);
        return { success: false, error: error.message };
    }
}

/**
 * Obtiene una vista resumida de las analíticas para el dashboard
 * @param {string} userId - ID del usuario
 * @returns {Promise<Object>} - Resumen de analíticas
 */
async function getDashboardSummary(userId) {
    try {
        // Obtener analíticas completas
        const result = await getUserAnalytics(userId);

        if (!result.success || !result.analytics) {
            return { success: false, error: result.error || 'No se encontraron analíticas' };
        }

        const analytics = result.analytics;

        // Crear un resumen con los datos más relevantes para el dashboard
        const summary = {
            folderStats: {
                active: analytics.folderStatusDistribution.nueva +
                    analytics.folderStatusDistribution.enProceso +
                    analytics.folderStatusDistribution.pendiente,
                closed: analytics.folderStatusDistribution.cerrada,
                distribution: analytics.folderStatusDistribution
            },
            financialStats: {
                totalActiveAmount: analytics.financialMetrics.totalActiveAmount,
                calculatorsAmount: Object.values(analytics.financialMetrics.calculatorsAmountByType)
                    .reduce((a, b) => a + b, 0)
            },
            upcomingDeadlines: analytics.upcomingDeadlines.next7Days,
            taskMetrics: {
                pendingTasks: analytics.taskMetrics.pendingTasks,
                completionRate: analytics.taskMetrics.completionRate
            },
            notificationMetrics: {
                unreadCount: analytics.notificationMetrics.unreadCount
            },
            trends: {
                newFolders: analytics.trendData.newFolders.slice(0, 3), // Últimos 3 meses
                movements: analytics.trendData.movements.slice(0, 3) // Últimos 3 meses
            },
            lastUpdated: analytics.lastUpdated
        };

        return { success: true, summary };
    } catch (error) {
        logger.error(`Error al obtener resumen para dashboard: ${error.message}`);
        return { success: false, error: error.message };
    }
}

module.exports = {
    generateUserAnalytics,
    generateAllUsersAnalytics,
    getUserAnalytics,
    getDashboardSummary
};