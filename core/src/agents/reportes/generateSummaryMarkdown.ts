import type { JunitResults } from "./parseJunitResults.js";

export function generateSummaryMarkdown(
  results: JunitResults,
  detailLevel: "resumen" | "completo"
): string {
  const lines: string[] = [];
  lines.push("# Resumen de ejecución");
  lines.push("");
  lines.push(`- Total: ${results.totalTests}`);
  lines.push(`- Pasados: ${results.passed}`);
  lines.push(`- Fallidos: ${results.failed}`);
  lines.push(`- Omitidos: ${results.skipped}`);
  lines.push(`- Duración: ${results.durationSeconds}s`);
  lines.push("");
  lines.push("## Fallos");
  lines.push("");

  const failures = results.testCases.filter((tc) => tc.status === "failed");
  if (failures.length === 0) {
    lines.push("Ningún test falló.");
  } else {
    for (const tc of failures) {
      lines.push(`- \`${tc.name}\` — ${tc.message ?? "sin mensaje"}`);
    }
  }

  if (detailLevel === "completo") {
    lines.push("");
    lines.push("## Pasados");
    lines.push("");
    const passedTests = results.testCases.filter((tc) => tc.status === "passed");
    if (passedTests.length === 0) {
      lines.push("Ningún test pasó.");
    } else {
      for (const tc of passedTests) {
        lines.push(`- \`${tc.name}\``);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
