import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface JunitTestCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

export interface JunitResults {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationSeconds: number;
  testCases: JunitTestCase[];
}

type RawJunitNode = string | { "@_message"?: string } | RawJunitNode[];

interface RawTestCase {
  "@_name": string;
  "@_time"?: string;
  failure?: RawJunitNode;
  error?: RawJunitNode;
  skipped?: RawJunitNode;
}

/**
 * Extracts the `message` attribute from a parsed junit-xml child node
 * (<failure>, <error>, <skipped>), regardless of the shape fast-xml-parser
 * produced for it:
 * - a plain object with `@_message` (attributes present)
 * - a bare string (no attributes — self-closed or text-only element)
 * - an array (repeated sibling elements under the same testcase) — takes
 *   the first element's message
 */
function extractMessage(node: unknown): string | undefined {
  if (node === null || node === undefined || typeof node === "string") {
    return undefined;
  }
  const candidate = Array.isArray(node) ? node[0] : node;
  if (candidate && typeof candidate === "object" && "@_message" in candidate) {
    const message = (candidate as { "@_message"?: unknown })["@_message"];
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

interface RawTestSuite {
  "@_time"?: string;
  testcase?: RawTestCase[];
}

interface RawTestSuites {
  testsuites?: {
    testsuite?: RawTestSuite[];
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "testsuite" || name === "testcase",
});

export function parseJunitResults(xml: string): JunitResults {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`El archivo de resultados no se pudo parsear como XML: ${validation.err.msg}`);
  }

  const parsed = parser.parse(xml) as RawTestSuites;
  const testsuites = parsed.testsuites?.testsuite ?? [];
  if (testsuites.length === 0) {
    throw new Error(
      "El archivo de resultados no tiene el formato esperado (falta <testsuites><testsuite>...)."
    );
  }

  const testCases: JunitTestCase[] = [];
  let durationSeconds = 0;

  for (const suite of testsuites) {
    const time = Number(suite["@_time"] ?? 0);
    durationSeconds += Number.isFinite(time) ? time : 0;
    for (const testcase of suite.testcase ?? []) {
      const name = testcase["@_name"];
      if ("failure" in testcase || "error" in testcase) {
        const message = extractMessage(testcase.failure) ?? extractMessage(testcase.error);
        testCases.push({ name, status: "failed", message });
      } else if ("skipped" in testcase) {
        testCases.push({ name, status: "skipped", message: extractMessage(testcase.skipped) });
      } else {
        testCases.push({ name, status: "passed" });
      }
    }
  }

  const passed = testCases.filter((tc) => tc.status === "passed").length;
  const failed = testCases.filter((tc) => tc.status === "failed").length;
  const skipped = testCases.filter((tc) => tc.status === "skipped").length;

  return {
    totalTests: testCases.length,
    passed,
    failed,
    skipped,
    durationSeconds,
    testCases,
  };
}
