// The OTLP trace request an OpenTelemetry SDK or collector sends over HTTP, written as protobuf by hand: the tests and
// scripts/demo.ts push real requests with it. Traces itself never decodes them; VictoriaTraces does.
// The messages are opentelemetry/proto/collector/trace/v1 ExportTraceServiceRequest and the ones it holds.
import { randomBytes } from "node:crypto";

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
const KINDS: Record<SpanKind, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };

export type Attribute = string | number | boolean;

export interface SpanInput {
  /** 32 hex digits. */
  traceId: string;
  /** 16 hex digits. */
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** Start, in milliseconds since the epoch; fractions are kept to the microsecond. */
  startMs: number;
  durationMs: number;
  attributes?: Record<string, Attribute>;
  error?: string;
  events?: Array<{ name: string; atMs: number; attributes?: Record<string, Attribute> }>;
}

export interface ResourceInput {
  /** service.name and the other resource attributes, such as service.version. */
  attributes: Record<string, Attribute> & { "service.name": string };
  spans: SpanInput[];
}

const varint = (n: number | bigint) => {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const out: number[] = [];
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
};
const key = (field: number, wire: number) => varint((field << 3) | wire);
const bytes = (field: number, b: Buffer) => Buffer.concat([key(field, 2), varint(b.length), b]);
const str = (field: number, s: string) => bytes(field, Buffer.from(s, "utf8"));
const uint = (field: number, n: number | bigint) => Buffer.concat([key(field, 0), varint(n)]);
const fixed64 = (field: number, n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return Buffer.concat([key(field, 1), b]);
};
const double = (field: number, n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return Buffer.concat([key(field, 1), b]);
};

/** AnyValue: string 1, bool 2, int 3, double 4. */
const anyValue = (v: Attribute) =>
  typeof v === "string" ? str(1, v) : typeof v === "boolean" ? uint(2, v ? 1 : 0) : Number.isInteger(v) ? uint(3, v) : double(4, v);
const keyValues = (field: number, attrs: Record<string, Attribute> = {}) =>
  Object.entries(attrs).map(([k, v]) => bytes(field, Buffer.concat([str(1, k), bytes(2, anyValue(v))])));
const nanos = (ms: number) => BigInt(Math.round(ms * 1000)) * 1000n;

function span(s: SpanInput): Buffer {
  const start = nanos(s.startMs);
  return Buffer.concat([
    bytes(1, Buffer.from(s.traceId, "hex")),
    bytes(2, Buffer.from(s.spanId, "hex")),
    ...(s.parentSpanId ? [bytes(4, Buffer.from(s.parentSpanId, "hex"))] : []),
    str(5, s.name),
    uint(6, KINDS[s.kind]),
    fixed64(7, start),
    fixed64(8, start + nanos(s.durationMs)),
    ...keyValues(9, s.attributes),
    ...(s.events ?? []).map((e) => bytes(11, Buffer.concat([fixed64(1, nanos(e.atMs)), str(2, e.name), ...keyValues(3, e.attributes)]))),
    // Status: message 2, code 3 (2 is ERROR).
    ...(s.error !== undefined ? [bytes(15, Buffer.concat([str(2, s.error), uint(3, 2)]))] : []),
  ]);
}

/** An ExportTraceServiceRequest with one ResourceSpans per service, as protobuf. */
export function encodeTraces(resources: ResourceInput[]): Buffer {
  return Buffer.concat(
    resources.map((r) =>
      bytes(
        1,
        Buffer.concat([
          bytes(1, Buffer.concat(keyValues(1, r.attributes))),
          bytes(2, Buffer.concat([bytes(1, str(1, "openasy-traces")), ...r.spans.map((s) => bytes(2, span(s)))])),
        ]),
      ),
    ),
  );
}

export const traceId = () => randomBytes(16).toString("hex");
export const spanId = () => randomBytes(8).toString("hex");
