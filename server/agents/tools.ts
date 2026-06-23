import { getAgentSpec } from "./registry";

/** Impose la fiche métier : un agent ne peut utiliser QUE ses outils déclarés. */
export function assertToolAllowed(agentKey: string, toolKey: string): void {
  const spec = getAgentSpec(agentKey);
  if (!spec) throw new Error(`Agent inconnu : ${agentKey}`);
  if (!spec.tools.includes(toolKey)) {
    throw new Error(
      `Outil « ${toolKey} » non autorisé pour l'agent ${agentKey}`
    );
  }
}

export type ToolFn = (args: any) => Promise<any>;

/** Exécute un outil au nom d'un agent, après contrôle de la fiche. */
export async function runAgentTool(
  agentKey: string,
  toolKey: string,
  fn: ToolFn,
  args: any
): Promise<any> {
  assertToolAllowed(agentKey, toolKey);
  return fn(args);
}
