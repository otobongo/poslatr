// Every provider performs ALL network I/O through an injected Transport. The
// contract harness injects a fake to script publish outcomes and prove error
// mapping; production wires a real fetch-backed transport (with the SSRF guard
// from packages/media once ISS-006 lands).

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
}
