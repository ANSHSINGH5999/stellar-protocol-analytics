export const analyticsRoutes = async (fastify, opts) => {
    const { prisma } = opts;
    /**
     * GET /analytics/tvl
     * Returns daily tvl_usd and total_staked from daily_summaries.
     */
    fastify.get("/analytics/tvl", async (request) => {
        const days = parseInt(request.query.days || "30", 10);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const summaries = await prisma.dailySummary.findMany({
            where: { date: { gte: since } },
            orderBy: { date: "asc" },
            select: { date: true, tvlUsd: true, totalStaked: true, totalBorrowed: true },
        });
        return summaries.map(s => ({
            date: s.date.toISOString(),
            tvlUsd: Number(s.tvlUsd) || 0,
            totalStaked: Number(s.totalStaked) || 0,
            totalBorrowed: Number(s.totalBorrowed) || 0,
        }));
    });
    /**
     * GET /analytics/utilization
     * Returns borrow vs total liquidity over time.
     */
    fastify.get("/analytics/utilization", async (request) => {
        const days = parseInt(request.query.days || "30", 10);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const summaries = await prisma.dailySummary.findMany({
            where: { date: { gte: since } },
            orderBy: { date: "asc" },
            select: { date: true, totalStaked: true, totalBorrowed: true },
        });
        return summaries.map(s => {
            const staked = Number(s.totalStaked) || 0;
            const borrowed = Number(s.totalBorrowed) || 0;
            const utilization = staked > 0 ? (borrowed / staked) * 100 : 0;
            return {
                date: s.date.toISOString(),
                utilization: utilization,
            };
        });
    });
    /**
     * GET /analytics/revenue
     * Returns aggregated revenue by event type.
     */
    fastify.get("/analytics/revenue", async (request) => {
        const days = parseInt(request.query.days || "30", 10);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const events = await prisma.protocolEvent.groupBy({
            by: ['eventType'],
            where: { timestamp: { gte: since } },
            _sum: { revenueUsd: true },
        });
        const revenueByType = {};
        let totalRevenue = 0;
        for (const e of events) {
            const amt = Number(e._sum.revenueUsd) || 0;
            revenueByType[e.eventType] = amt;
            totalRevenue += amt;
        }
        return {
            totalRevenue,
            revenueByType,
        };
    });
    /**
     * GET /analytics/cohorts
     * Returns unique users count and avg position sizes (rough estimates based on events).
     */
    fastify.get("/analytics/cohorts", async () => {
        // Just a rough estimate of active users in the last 30 days
        const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [activeUsers30, activeUsers7, eventStats] = await Promise.all([
            prisma.protocolEvent.findMany({
                where: { timestamp: { gte: since30 } },
                select: { userAddress: true },
                distinct: ['userAddress'],
            }),
            prisma.protocolEvent.findMany({
                where: { timestamp: { gte: since7 } },
                select: { userAddress: true },
                distinct: ['userAddress'],
            }),
            prisma.protocolEvent.aggregate({
                where: { timestamp: { gte: since30 }, eventType: { in: ['stake', 'borrow', 'lp_deposit'] } },
                _avg: { amountUsd: true },
            })
        ]);
        return {
            activeUsers30Days: activeUsers30.length,
            activeUsers7Days: activeUsers7.length,
            avgPositionSizeUsd: Number(eventStats._avg.amountUsd) || 0,
        };
    });
    /**
     * GET /analytics/events
     * Returns recent protocol events for live feed.
     */
    fastify.get("/analytics/events", async (request) => {
        const limit = parseInt(request.query.limit || "50", 10);
        const events = await prisma.protocolEvent.findMany({
            orderBy: { timestamp: "desc" },
            take: limit,
            select: {
                id: true,
                timestamp: true,
                eventType: true,
                userAddress: true,
                amountUsd: true,
                amount: true,
                asset: true,
                txHash: true,
            }
        });
        return events.map(e => ({
            ...e,
            id: e.id.toString(), // Convert BigInt to string for JSON serialization
            amount: Number(e.amount) || 0,
            amountUsd: Number(e.amountUsd) || 0,
            timestamp: e.timestamp.toISOString(),
        }));
    });
};
//# sourceMappingURL=analytics.js.map