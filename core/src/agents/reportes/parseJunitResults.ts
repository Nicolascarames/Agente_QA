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

interface RawJunitNode {
  "@_message"?: string;
}

interface RawTestCase {
  "@_name": string;
  "@_time"?: string;
  failure?: RawJunitNode;
  error?: RawJunitNode;
  skipped?: RawJunitNode;
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
    durationSeconds += Number(suite["@_time"] ?? 0);
    for (const testcase of suite.testcase ?? []) {
      const name = testcase["@_name"];
      if (testcase.failure || testcase.error) {
        const message = testcase.failure?.["@_message"] ?? testcase.error?.["@_message"];
        testCases.push({ name, status: "failed", message });
      } else if (testcase.skipped) {
        testCases.push({ name, status: "skipped", message: testcase.skipped["@_message"] });
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
