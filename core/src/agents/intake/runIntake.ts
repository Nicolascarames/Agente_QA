import type { LLMProvider } from "../../llm/provider.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import type { ScenarioCandidate } from "../../appMap/schema.js";
import type { EmitEvent } from "../../events/agentEvent.js";
import { loadAppMap } from "../../appMap/mapStore.js";
import { checkAmbiguity } from "./ambiguityChecker.js";
import { generateGherkin } from "./gherkinGenerator.js";
import { checkFeatureLiterals } from "./checkFeatureLiterals.js";
import { writeFeatureFile, featureFileExists, featureFilePath } from "./writeFeatureFile.js";

export interface IntakeCallbacks {
  askUser(question: string): Promise<string>;
  chooseScenario(candidates: ScenarioCandidate[]): Promise<ScenarioCandidate | null>;
  presentForApproval(plan: GherkinPlan): Promise<{ approved: boolean; feedback?: string }>;
  confirmOverwrite(filePath: string): Promise<boolean>;
}

export interface RunIntakeOptions {
  initialText: string;
  llm: LLMProvider;
  projectRoot: string;
  testsDir: string;
  callbacks: IntakeCallbacks;
  emit: EmitEvent;
}

const MAX_GROUNDING_ATTEMPTS = 3;

export async function runIntake(options: RunIntakeOptions): Promise<{ plan: GherkinPlan; filePath: string }> {
  const { llm, projectRoot, testsDir, callbacks, emit } = options;

  const map = await loadAppMap(projectRoot);
  if (!map) {
    throw new Error(
      'No hay mapa de la aplicación. Ejecuta "agente-qa map" antes de crear un plan de pruebas: sin él, los textos esperados serían inventados.'
    );
  }

  let text = options.initialText;
  let screenId = map.screens[0]?.id ?? "";
  let usingMapScenario = false;

  if (map.scenarios.length > 0) {
    const chosen = await callbacks.chooseScenario(map.scenarios);
    if (chosen) {
      text = chosen.title;
      screenId = chosen.screenId;
      usingMapScenario = true;
    }
  }

  // A scenario picked from the map's own candidates is already well-specified —
  // Explorador produced it as a concrete title. The ambiguity check exists to
  // clarify freeform text the user typed, so it only runs for that: no map
  // scenario was chosen, whether because the map has none or the user declined
  // them to type their own request.
  if (!usingMapScenario) {
    const ambiguity = await checkAmbiguity(text, llm);
    if (ambiguity.ambiguous) {
      const answers: string[] = [];
      for (const question of ambiguity.questions) {
        answers.push(`${question}\n${await callbacks.askUser(question)}`);
      }
      text = `${text}\n\nAclaraciones:\n${answers.join("\n\n")}`;
    }
  }

  let plan = await generateGherkin(text, llm, map, screenId);

  for (let attempt = 1; attempt <= MAX_GROUNDING_ATTEMPTS; attempt++) {
    const { missing, candidates } = checkFeatureLiterals(plan.featureText, map);
    if (missing.length === 0) break;
    emit({
      agent: "intake", status: "warn", depth: 1,
      message: `${missing.length} texto(s) no existen en la aplicación, regenerando`,
      detail: missing.map((m) => `"${m.literal}"`).join(", "),
    });
    if (attempt === MAX_GROUNDING_ATTEMPTS) {
      throw new Error(
        `El plan sigue esperando textos que no existen en la aplicación: ${missing
          .map((m) => `"${m.literal}"`)
          .join(", ")}.\nTextos reales de esa pantalla: ${candidates.slice(0, 20).join(" · ")}`
      );
    }
    text = `${text}\n\nEstos textos NO existen en la aplicación y no debes usarlos: ${missing
      .map((m) => `"${m.literal}"`)
      .join(", ")}`;
    plan = await generateGherkin(text, llm, map, screenId);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decision = await callbacks.presentForApproval(plan);
    if (decision.approved) break;
    text = `${text}\n\nPlan anterior:\n"""\n${plan.featureText}\n"""\n\nCambios solicitados:\n${decision.feedback ?? ""}`;
    plan = await generateGherkin(text, llm, map, screenId);
  }

  const alreadyExists = await featureFileExists(projectRoot, testsDir, plan.fileName);
  if (alreadyExists) {
    const targetPath = featureFilePath(projectRoot, testsDir, plan.fileName);
    if (!(await callbacks.confirmOverwrite(targetPath))) {
      throw new Error(`Cancelado: ya existe ${targetPath} y no se sobrescribió.`);
    }
  }

  const filePath = await writeFeatureFile(projectRoot, testsDir, plan);
  emit({ agent: "intake", status: "ok", depth: 0, message: `Plan escrito en ${filePath}` });
  return { plan, filePath };
}
