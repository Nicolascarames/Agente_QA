export function parseFeatureHeader(featureText: string): string | null {
  const firstLine = featureText.split("\n", 1)[0];
  const match = firstLine.match(/^# agente-qa:pattern=(.+)$/);
  return match ? match[1].trim() : null;
}
