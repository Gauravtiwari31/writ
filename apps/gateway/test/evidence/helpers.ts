import { decideApproval } from "../../src/approvals/index";
import type { Services } from "../../src/deps";
import type { Seeded } from "../money/fixtures";

export function approvalDecide(services: Services, seeded: Seeded, approvalId: string, signature: unknown) {
  return decideApproval(services, { tenantId: seeded.tenantId, userId: seeded.userId, approvalId, decision: "APPROVE", signature: signature as never });
}
