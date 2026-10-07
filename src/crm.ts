import { config, secret } from "./config";

/** An early-access request as the CRM needs to see it. */
export interface CrmLead {
  id: string;
  createdAt: Date;
  name: string;
  email: string;
  note: string;
}

export type CrmOutcome = { status: "delivered" | "duplicate" | "off" } | { status: "failed"; error: string };

const CONTRACT = "sales-intake/v1";
const CONSENT = "live-slides-early-access-v1";
const TIMEOUT_MS = 8000;

/**
 * Delivery of early-access requests to the Sales CRM (Twenty) under the shared intake contract:
 * one intake lead per request, deduplicated by the request id, status "new" until a human
 * qualifies it there. Without an address or a key the CRM step is simply off.
 */
export class Crm {
  private key: string | null = null;

  get enabled(): boolean {
    return Boolean(config.crm.url && (process.env[config.crm.keyEnv] || config.crm.keyPassEntry));
  }

  /** The payload is a pure function of the request, so a retry sends exactly the same thing. */
  payload(lead: CrmLead): Record<string, unknown> {
    const occurredAt = lead.createdAt.toISOString();
    return {
      contractVersion: CONTRACT,
      name: lead.name,
      sourceSystem: config.crm.sourceSystem,
      sourceApplicationId: lead.id,
      sourceEventType: "early_access_requested",
      occurredAt,
      applicantName: lead.name,
      contact: lead.email,
      ...(lead.note ? { leadMessage: lead.note } : {}),
      productTier: config.crm.productTier,
      source: config.crm.sourceSystem,
      attribution: { landingPage: "/", referrer: null, utm: {} },
      consentVersion: CONSENT,
      consentedAt: occurredAt,
      intakeStatus: "new",
    };
  }

  async deliver(lead: CrmLead): Promise<CrmOutcome> {
    if (!this.enabled) return { status: "off" };
    try {
      this.key ??= await secret(config.crm.keyEnv, config.crm.keyPassEntry);
      const response = await fetch(`${config.crm.url}/intakeLeads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify(this.payload(lead)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 409) return { status: "duplicate" };
      if (!response.ok) return { status: "failed", error: `HTTP ${response.status} ${(await response.text()).slice(0, 200)}` };
      return { status: "delivered" };
    } catch (error) {
      return { status: "failed", error: (error as Error).name === "TimeoutError" ? `Нет ответа за ${TIMEOUT_MS / 1000} с` : (error as Error).message };
    }
  }
}
