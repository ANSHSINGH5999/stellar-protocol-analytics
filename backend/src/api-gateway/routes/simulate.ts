import { FastifyPluginAsync } from "fastify";
import { simulateDeposit, simulateRequestWithdrawal } from "../../staking-engine/contractClient.js";

export const simulateRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /simulate/deposit
   * Simulates a deposit and returns the expected sXLM output without actually executing it.
   */
  fastify.post<{
    Body: { walletPublic: string; amountStroops: string };
  }>("/simulate/deposit", {
    schema: {
      body: {
        type: "object",
        required: ["walletPublic", "amountStroops"],
        properties: {
          walletPublic: { type: "string" },
          amountStroops: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { walletPublic, amountStroops } = request.body;
      const xlmAmount = BigInt(amountStroops);
      
      const result = await simulateDeposit(walletPublic, xlmAmount);
      
      return reply.send({
        success: true,
        data: {
          sxlmMinted: result.sxlmMinted.toString(),
          exchangeRate: result.exchangeRate,
        }
      });
    } catch (error: any) {
      fastify.log.error(`Simulate deposit error: ${error.message}`);
      return reply.status(400).send({ success: false, error: error.message });
    }
  });

  /**
   * POST /simulate/withdrawal
   * Simulates a withdrawal request without executing it.
   */
  fastify.post<{
    Body: { walletPublic: string; sxlmAmountStroops: string };
  }>("/simulate/withdrawal", {
    schema: {
      body: {
        type: "object",
        required: ["walletPublic", "sxlmAmountStroops"],
        properties: {
          walletPublic: { type: "string" },
          sxlmAmountStroops: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { walletPublic, sxlmAmountStroops } = request.body;
      const sxlmAmount = BigInt(sxlmAmountStroops);
      
      const result = await simulateRequestWithdrawal(walletPublic, sxlmAmount);
      
      return reply.send({
        success: true,
        data: {
          sxlmAmount: result.sxlmAmount.toString(),
          xlmAmount: result.xlmAmount.toString(),
          exchangeRate: result.exchangeRate,
          isInstant: result.isInstant,
          unlockTime: result.unlockTime.toISOString(),
        }
      });
    } catch (error: any) {
      fastify.log.error(`Simulate withdrawal error: ${error.message}`);
      return reply.status(400).send({ success: false, error: error.message });
    }
  });
};
