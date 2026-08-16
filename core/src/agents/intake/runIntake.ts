import type { LLMProvider } from "../../llm/provider.js";
import type { GherkinPlan } from "../../schemas/gherkinPlan.js";
import type { AppMap, ScenarioCandidate } from "../../appMap/schema.js";
import type { EmitEvent } from "../../events/agentEvent.js";
import { loadAppMap } from "../../appMap/mapStore.js";
import { findScreen } from "../../appMap/mapQuery.js";
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

/**
 * Generates a plan and keeps regenerating it until it is grounded in the map:
 * every scenario carries a resolvable `@screen:` tag AND every quoted literal
 * exists in the map. Used both after the initial generation and after every
 * feedback regeneration in the approval loop below, so no path to disk can
 * skip the check — that gap was the exact defect this task exists to close.
 */
async function generateGroundedPlan(
  text: string,
  llm: LLMProvider,
  map: AppMap,
  screenId: string,
  emit: EmitEvent
): Promise<{ plan: GherkinPlan; text: string }> {
  let plan = await generateGherkin(text, llm, map, screenId);

  for (let attempt = 1; attempt <= MAX_GROUNDING_ATTEMPTS; attempt++) {
    const { missing, candidates, screenTagFound } = checkFeatureLiterals(plan.featureText, map);
    if (screenTagFound && missing.length === 0) break;

    const isLastAttempt = attempt === MAX_GROUNDING_ATTEMPTS;

    if (!screenTagFound) {
      emit({
        agent: "intake", status: "warn", depth: 1,
        message: `El plan no incluye la etiqueta @screen:${screenId} en ningún escenario, regenerando`,
      });
      if (isLastAttempt) {
        throw new Error(
          `El plan generado no incluye la etiqueta @screen:${screenId} en ningún escenario, y no se corrigió tras ${MAX_GROUNDING_ATTEMPTS} intentos. Revísalo manualmente antes de continuar.`
        );
      }
      text = `${text}\n\nEl plan anterior no incluía la etiqueta @screen:${screenId}. Cada escenario debe llevarla justo antes de sus pasos. Añádela y genera el plan completo de nuevo.`;
    } else {
      emit({
        agent: "intake", status: "warn", depth: 1,
        message: `${missing.length} texto(s) no existen en la aplicación, regenerando`,
        detail: missing.map((m) => `"${m.literal}"`).join(", "),
      });
      if (isLastAttempt) {
        throw new Error(
          `El plan sigue esperando textos que no existen en la aplicación: ${missing
            .map((m) => `"${m.literal}"`)
            .join(", ")}.\nTextos reales de esa pantalla: ${candidates.slice(0, 20).join(" · ")}`
        );
      }
      text = `${text}\n\nEstos textos NO existen en la aplicación y no debes usarlos: ${missing
        .map((m) => `"${m.literal}"`)
        .join(", ")}`;
    }

    plan = await generateGherkin(text, llm, map, screenId);
  }

  return { plan, text };
}

export async function runIntake(options: RunIntakeOptions): Promise<{ plan: GherkinPlan; filePath: string }> {
  const { llm, projectRoot, testsDir, callbacks, emit } = options;

  const map = await loadAppMap(projectRoot);
  if (!map) {
    throw new Error(
      'No hay mapa de la aplicación. Ejecuta "agente-qa map" antes de crear un plan de pruebas: sin él, los textos esperados serían inventados.'
    );
  }

  if (map.screens.length === 0) {
    throw new Error(
      'El mapa de la aplicación no tiene pantallas. Ejecuta "agente-qa map" para explorar la aplicación antes de crear un plan de pruebas.'
    );
  }

  let text = options.initialText;
  let screenId = map.screens[0].id;
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
  // Explorador produced it as a concrete title. Everything below only runs when
  // no map scenario was chosen, whether because the map has none or the user
  // declined them to type their own request.
  if (!usingMapScenario) {
    // The CLI lets the user leave the request empty to see the map's scenario
    // suggestions; if they decline those too, `text` is still empty here and
    // generation must not proceed on nothing.
    if (text.trim().length === 0) {
      text = await callbacks.askUser("¿Qué quieres probar? Describe la funcionalidad o el flujo.");
    }

    // Real screen selection is out of scope here: a freeform request always
    // grounds on the map's first screen. Surface that choice so the user can
    // see it rather than have it happen silently.
    const screenName = findScreen(map, screenId)?.name ?? screenId;
    emit({
      agent: "intake", status: "warn", depth: 1,
      message: `No se eligió un escenario del mapa: el plan se generará sobre la pantalla "${screenName}".`,
    });

    const ambiguity = await checkAmbiguity(text, llm);
    if (ambiguity.ambiguous) {
      const answers: string[] = [];
      for (const question of ambiguity.questions) {
        answers.push(`${question}\n${await callbacks.askUser(question)}`);
      }
      text = `${text}\n\nAclaraciones:\n${answers.join("\n\n")}`;
    }
  }

  let plan: GherkinPlan;
  ({ plan, text } = await generateGroundedPlan(text, llm, map, screenId, emit));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const decision = await callbacks.presentForApproval(plan);
    if (decision.approved) break;
    text = `${text}\n\nPlan anterior:\n"""\n${plan.featureText}\n"""\n\nCambios solicitados:\n${decision.feedback ?? ""}`;
    ({ plan, text } = await generateGroundedPlan(text, llm, map, screenId, emit));
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
