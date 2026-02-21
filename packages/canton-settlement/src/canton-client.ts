/**
 * Canton JSON API Client (TypeScript)
 *
 * Lightweight client for querying and exercising Canton Daml contracts.
 * Supports both JSON API v1 (Canton 2.x open-source) and v2 (Canton 3.x).
 * Auto-detects the API version on first call.
 *
 * Canton is used as a coordination layer — it records multi-party agreements
 * and ZK attestations. Funds never touch Canton; they live on EVM.
 */

import type {
  CantonConfig,
  CustodyAttestation,
  Settlement,
} from "./types";

const PACKAGE_NAME = "canton-zk-custody";

const TEMPLATES = {
  attestation: `#${PACKAGE_NAME}:CustodyAttestation:CustodyAttestation`,
  settlement: `#${PACKAGE_NAME}:CrossChainSettlement:CrossChainSettlement`,
  proposal: `#${PACKAGE_NAME}:AttestationProposal:AttestationProposal`,
  reserve: `#${PACKAGE_NAME}:ProofOfReserve:ProofOfReserve`,
} as const;

// v1 template IDs use packageId:Module:Template (without # prefix)
function toV1TemplateId(v2Id: string): string {
  return v2Id.replace(/^#/, "");
}

type ApiVersion = "v1" | "v2" | null;

export class CantonClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private userId: string;
  private actAs: string[];
  private readAs: string[];
  private apiVersion: ApiVersion = null;
  private ledgerId: string;
  private applicationId: string;

  constructor(config: CantonConfig) {
    this.baseUrl = config.participantUrl.replace(/\/$/, "");
    this.userId = config.userId;
    this.actAs = config.actAs;
    this.readAs = config.readAs;
    this.ledgerId = config.ledgerId || config.userId;
    this.applicationId = config.applicationId || "vaeb-canton";
    this.headers = { "Content-Type": "application/json" };
    if (config.authToken) {
      this.headers["Authorization"] = `Bearer ${config.authToken}`;
    }
  }

  // ── Health ──────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try {
      // Try v2 first (Canton 3.x)
      const v2Res = await fetch(`${this.baseUrl}/v2/parties/participant-id`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      if (v2Res.ok) {
        this.apiVersion = "v2";
        return true;
      }
    } catch {
      // v2 not available, try v1
    }

    try {
      // Fall back to v1 (Canton 2.x)
      const v1Res = await fetch(`${this.baseUrl}/v1/parties`, {
        headers: this.getV1Headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (v1Res.ok) {
        this.apiVersion = "v1";
        return true;
      }
    } catch {
      // Neither available
    }

    return false;
  }

  /**
   * Returns the detected API version, or null if not yet detected.
   */
  getApiVersion(): ApiVersion {
    return this.apiVersion;
  }

  // ── Query ───────────────────────────────────────────────────

  async queryAttestations(): Promise<CustodyAttestation[]> {
    return this.queryContracts(TEMPLATES.attestation);
  }

  async querySettlements(): Promise<Settlement[]> {
    return this.queryContracts(TEMPLATES.settlement);
  }

  async queryContracts<T = any>(templateId: string): Promise<T[]> {
    await this.detectApiVersion();

    if (this.apiVersion === "v1") {
      return this.queryContractsV1<T>(templateId);
    }
    return this.queryContractsV2<T>(templateId);
  }

  // ── Exercise ────────────────────────────────────────────────

  async exerciseChoice(
    templateId: string,
    contractId: string,
    choice: string,
    argument: Record<string, any> = {}
  ): Promise<any> {
    await this.detectApiVersion();

    if (this.apiVersion === "v1") {
      return this.exerciseChoiceV1(templateId, contractId, choice, argument);
    }
    return this.submitAndWaitV2({
      ExerciseCommand: { templateId, contractId, choice, choiceArgument: argument },
    });
  }

  async executeSettlement(
    settlementId: string,
    attestationId: string
  ): Promise<any> {
    return this.exerciseChoice(
      TEMPLATES.settlement,
      settlementId,
      "Execute",
      { attestationCid: attestationId }
    );
  }

  // ── v1 API (Canton 2.x open-source / sandbox) ──────────────

  private getV1Headers(): Record<string, string> {
    // v1 requires a JWT with ledgerId, applicationId, actAs, readAs
    const headers = { ...this.headers };
    if (!headers["Authorization"]) {
      // Build an insecure JWT for development (allow-insecure-tokens = true)
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: this.userId,
        ledgerId: this.ledgerId,
        applicationId: this.applicationId,
        actAs: this.actAs,
        readAs: this.readAs,
      })).toString("base64url");
      headers["Authorization"] = `Bearer ${header}.${payload}.unsigned`;
    }
    return headers;
  }

  private getV1AdminHeaders(): Record<string, string> {
    const headers = { ...this.headers };
    if (!headers["Authorization"]) {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: this.userId,
        admin: true,
      })).toString("base64url");
      headers["Authorization"] = `Bearer ${header}.${payload}.unsigned`;
    }
    return headers;
  }

  private async queryContractsV1<T>(templateId: string): Promise<T[]> {
    const v1TemplateId = toV1TemplateId(templateId);

    const res = await fetch(`${this.baseUrl}/v1/query`, {
      method: "POST",
      headers: this.getV1Headers(),
      body: JSON.stringify({ templateIds: [v1TemplateId] }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton v1 query failed: ${res.status} ${text.slice(0, 300)}`);
    }

    const data: any = await res.json();
    const results = data.result ?? [];

    const contracts: T[] = [];
    for (const entry of results) {
      if (entry?.contractId) {
        contracts.push({
          contractId: entry.contractId,
          ...entry.payload,
        } as T);
      }
    }
    return contracts;
  }

  private async exerciseChoiceV1(
    templateId: string,
    contractId: string,
    choice: string,
    argument: Record<string, any>
  ): Promise<any> {
    const v1TemplateId = toV1TemplateId(templateId);

    const res = await fetch(`${this.baseUrl}/v1/exercise`, {
      method: "POST",
      headers: this.getV1Headers(),
      body: JSON.stringify({
        templateId: v1TemplateId,
        contractId,
        choice,
        argument,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton v1 exercise failed: ${res.status} ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── v2 API (Canton 3.x / Runtime 3.4.10+) ─────────────────

  private async queryContractsV2<T>(templateId: string): Promise<T[]> {
    const offset = await this.getLedgerEnd();

    const filtersByParty: Record<string, any> = {};
    for (const party of [...this.actAs, ...this.readAs]) {
      filtersByParty[party] = {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: { templateId, includeCreatedEventBlob: false },
              },
            },
          },
        ],
      };
    }

    const res = await fetch(`${this.baseUrl}/v2/state/active-contracts`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        eventFormat: { filtersByParty, verbose: true },
        activeAtOffset: offset,
      }),
    });

    if (!res.ok) {
      throw new Error(`Canton v2 query failed: ${res.status} ${res.statusText}`);
    }

    const data: any = await res.json();
    const entries =
      data.contractEntries ?? data.activeContracts ?? (Array.isArray(data) ? data : []);

    const contracts: T[] = [];
    for (const entry of entries) {
      const created =
        entry.CreatedEvent ?? entry.created ?? entry.createdEvent ?? entry;
      if (created?.contractId) {
        contracts.push({
          contractId: created.contractId,
          ...created.createArguments,
        } as T);
      }
    }
    return contracts;
  }

  private async getLedgerEnd(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Ledger end failed: ${res.status}`);
    const data: any = await res.json();
    return data.offset ?? 0;
  }

  private async submitAndWaitV2(command: any): Promise<any> {
    const body = {
      commands: [command],
      userId: this.userId,
      commandId: `vaeb-canton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actAs: this.actAs,
      readAs: this.readAs,
      workflowId: "vaeb-canton-settlement",
      submissionId: `vaeb-canton-${Date.now()}`,
      disclosedContracts: [],
      domainId: "",
      packageIdSelectionPreference: [],
      deduplicationPeriod: { Empty: {} },
    };

    const res = await fetch(`${this.baseUrl}/v2/commands/submit-and-wait`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton v2 submit failed: ${res.status} ${text.slice(0, 300)}`);
    }

    return res.json();
  }

  // ── API Version Detection ─────────────────────────────────

  private async detectApiVersion(): Promise<void> {
    if (this.apiVersion) return;

    // Try v2 first (Canton 3.x)
    try {
      const res = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.apiVersion = "v2";
        return;
      }
    } catch {
      // Not v2
    }

    // Try v1 (Canton 2.x)
    try {
      const res = await fetch(`${this.baseUrl}/v1/parties`, {
        headers: this.getV1AdminHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.apiVersion = "v1";
        return;
      }
    } catch {
      // Neither available
    }

    throw new Error(
      `Cannot connect to Canton at ${this.baseUrl}. ` +
      `Tried both v1 and v2 JSON APIs. Is Canton running?`
    );
  }
}
