import { describe, it, expect } from "vitest";
import { parseJunitResults } from "./parseJunitResults.js";

const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="1.234">
    <testcase classname="tests.test_login" name="test_ok" time="0.400" />
    <testcase classname="tests.test_login" name="test_fail" time="0.500">
      <failure message="AssertionError: boom">Traceback (most recent call last)...</failure>
    </testcase>
    <testcase classname="tests.test_login" name="test_skip" time="0.100">
      <skipped message="not ready" />
    </testcase>
  </testsuite>
</testsuites>
`;

describe("parseJunitResults", () => {
  it("counts passed, failed, and skipped test cases", () => {
    const results = parseJunitResults(sampleXml);
    expect(results.totalTests).toBe(3);
    expect(results.passed).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.skipped).toBe(1);
  });

  it("sums the duration from the testsuite time attribute", () => {
    const results = parseJunitResults(sampleXml);
    expect(results.durationSeconds).toBe(1.234);
  });

  it("extracts the one-line failure message from the failure's message attribute, not the full traceback", () => {
    const results = parseJunitResults(sampleXml);
    const failed = results.testCases.find((tc) => tc.status === "failed");
    expect(failed?.name).toBe("test_fail");
    expect(failed?.message).toBe("AssertionError: boom");
  });

  it("marks a test with an <error> child as failed too, using its message", () => {
    const xmlWithError = `<testsuites>
  <testsuite name="pytest" tests="1" time="0.2">
    <testcase classname="tests.test_x" name="test_broken" time="0.2">
      <error message="RuntimeError: setup crashed">...</error>
    </testcase>
  </testsuite>
</testsuites>`;
    const results = parseJunitResults(xmlWithError);
    expect(results.testCases[0]).toEqual({
      name: "test_broken",
      status: "failed",
      message: "RuntimeError: setup crashed",
    });
    expect(results.failed).toBe(1);
  });

  it("handles a single testcase without an array wrapper in the source XML", () => {
    const singleCaseXml = `<testsuites>
  <testsuite name="pytest" tests="1" time="0.1">
    <testcase classname="tests.test_x" name="test_only" time="0.1" />
  </testsuite>
</testsuites>`;
    const results = parseJunitResults(singleCaseXml);
    expect(results.totalTests).toBe(1);
    expect(results.testCases[0]).toEqual({ name: "test_only", status: "passed" });
  });

  it("treats a non-numeric testsuite time attribute as 0 instead of poisoning the sum with NaN", () => {
    const badTimeXml = `<testsuites>
  <testsuite name="a" tests="1" time="not-a-number">
    <testcase classname="a" name="test_a" time="0.1" />
  </testsuite>
  <testsuite name="b" tests="1" time="2.5">
    <testcase classname="b" name="test_b" time="2.5" />
  </testsuite>
</testsuites>`;
    const results = parseJunitResults(badTimeXml);
    expect(Number.isNaN(results.durationSeconds)).toBe(false);
    expect(results.durationSeconds).toBe(2.5);
  });

  it("sums durations across multiple <testsuite> elements", () => {
    const multiSuiteXml = `<testsuites>
  <testsuite name="a" tests="1" time="1.0">
    <testcase classname="a" name="test_a" time="1.0" />
  </testsuite>
  <testsuite name="b" tests="1" time="2.5">
    <testcase classname="b" name="test_b" time="2.5" />
  </testsuite>
</testsuites>`;
    const results = parseJunitResults(multiSuiteXml);
    expect(results.totalTests).toBe(2);
    expect(results.durationSeconds).toBe(3.5);
  });

  it("throws a clear error for XML that isn't well-formed", () => {
    expect(() => parseJunitResults("<testsuites><testsuite>")).toThrow(/no se pudo parsear/);
  });

  it("throws a clear error for well-formed XML that isn't junit-xml shaped", () => {
    expect(() => parseJunitResults("<not-junit><foo>bar</foo></not-junit>")).toThrow(
      /formato esperado/
    );
  });

  it("classifies a self-closed <failure/> with no attributes as failed, not passed", () => {
    const selfClosedFailureXml = `<testsuites>
  <testsuite name="pytest" tests="1" time="0.2">
    <testcase classname="tests.test_x" name="test_broken" time="0.2">
      <failure/>
    </testcase>
  </testsuite>
</testsuites>`;
    const results = parseJunitResults(selfClosedFailureXml);
    expect(results.testCases[0]).toEqual({
      name: "test_broken",
      status: "failed",
      message: undefined,
    });
    expect(results.failed).toBe(1);
    expect(results.passed).toBe(0);
  });

  it("keeps the first message when a testcase has two <error> children", () => {
    const doubleErrorXml = `<testsuites>
  <testsuite name="pytest" tests="1" time="0.2">
    <testcase classname="tests.test_x" name="test_double_error" time="0.2">
      <error message="first">setup crashed</error>
      <error message="second">teardown crashed</error>
    </testcase>
  </testsuite>
</testsuites>`;
    const results = parseJunitResults(doubleErrorXml);
    expect(results.testCases[0]).toEqual({
      name: "test_double_error",
      status: "failed",
      message: "first",
    });
    expect(results.failed).toBe(1);
  });
});
