/**
 * Planning domain operations: CRUD for plans, reviews, and research packets.
 *
 * P5.2: first-class planning domain with collaborative lifecycle:
 *   research -> synthesize -> challenge -> refine -> approve -> execute -> verify -> learn
 *
 * Plan states: proposed -> challenged -> operational -> superseded
 */
import type { Database, PlanRow, PlanReviewRow, ResearchPacketRow, PlanStatus, CreatePlanInput, CreatePlanReviewInput, CreateResearchPacketInput } from './types.js';
/**
 * Create a new plan in 'proposed' state.
 */
export declare function createPlan(db: Database, planId: string, input: CreatePlanInput, actorId?: string): PlanRow;
/**
 * Transition a plan's status. Validates allowed transitions.
 */
export declare function updatePlanStatus(db: Database, planId: string, newStatus: PlanStatus, actorId?: string): PlanRow;
/**
 * Get a plan by ID.
 */
export declare function getPlan(db: Database, planId: string): PlanRow | undefined;
/**
 * List plans, optionally filtered by status.
 */
export declare function listPlans(db: Database, status?: PlanStatus): PlanRow[];
/**
 * Add a review to a plan. Automatically transitions plan status if approved/challenged.
 */
export declare function addPlanReview(db: Database, reviewId: string, input: CreatePlanReviewInput): PlanReviewRow;
/**
 * Get reviews for a plan.
 */
export declare function getPlanReviews(db: Database, planId: string): PlanReviewRow[];
/**
 * Add a research packet, optionally linked to a plan.
 */
export declare function addResearchPacket(db: Database, packetId: string, input: CreateResearchPacketInput): ResearchPacketRow;
/**
 * Get research packets for a plan.
 */
export declare function getResearchPackets(db: Database, planId: string): ResearchPacketRow[];
/**
 * Link a plan to execution tasks.
 */
export declare function linkPlanTask(db: Database, planId: string, taskId: string): void;
/**
 * Get task IDs linked to a plan.
 */
export declare function getPlanTaskIds(db: Database, planId: string): string[];
//# sourceMappingURL=plan-ops.d.ts.map