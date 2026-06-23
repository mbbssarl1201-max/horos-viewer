export interface AgentKpi {
  key: string;
  label: string;
  target: number;
  unit: string;
  goal: "max" | "min";
}
export interface AgentSpec {
  key: string;
  name: string;
  role: string;
  objectives: string[];
  tasks: string[];
  tools: string[];
  access: string[];
  guardrails: string[];
  kpis: AgentKpi[];
}

export const AGENTS: AgentSpec[] = [
  {
    key: "redacteur",
    name: "Hermès Rédacteur",
    role: "Génère un brouillon de compte rendu à l'arrivée d'une étude.",
    objectives: [
      "Préparer des brouillons exploitables",
      "Faire gagner du temps au médecin",
    ],
    tasks: [
      "Analyser l'étude",
      "Rédiger un brouillon structuré",
      "Le placer dans la file à signer",
    ],
    tools: ["generateDraft"],
    access: ["study.read", "report.write_draft"],
    guardrails: [
      "Jamais de signature",
      "Jamais d'envoi",
      "Brouillon à valider par un médecin",
    ],
    kpis: [
      {
        key: "acceptanceRate",
        label: "Brouillons signés sans correction majeure",
        target: 70,
        unit: "%",
        goal: "max",
      },
      {
        key: "draftsPerDay",
        label: "Brouillons générés / jour",
        target: 10,
        unit: "",
        goal: "max",
      },
    ],
  },
  {
    key: "qualite",
    name: "Hermès Qualité",
    role: "Relit le brouillon (2e lecture) et signale les désaccords.",
    objectives: ["Réduire les erreurs", "Alerter sur les incohérences"],
    tasks: ["Vérifier la cohérence du CR", "Lever un désaccord si besoin"],
    tools: ["verifyDraft"],
    access: ["report.read"],
    guardrails: ["Aucune modification autonome du CR"],
    kpis: [
      {
        key: "disagreementConfirmedRate",
        label: "Désaccords confirmés par le médecin",
        target: 50,
        unit: "%",
        goal: "max",
      },
    ],
  },
  {
    key: "copilote",
    name: "Hermès Copilote",
    role: "Répond aux questions du médecin et explique les comptes rendus.",
    objectives: ["Expliquer le raisonnement", "Retrouver un dossier vite"],
    tasks: ["Chercher un patient", "Expliquer un CR"],
    tools: ["searchPatient", "explainReport"],
    access: ["patient.search", "report.read"],
    guardrails: ["Lecture seule", "Aucune action (signature/envoi/modif)"],
    kpis: [
      {
        key: "conversations",
        label: "Conversations",
        target: 1,
        unit: "",
        goal: "max",
      },
      {
        key: "avgLatencyMs",
        label: "Latence moyenne",
        target: 8000,
        unit: "ms",
        goal: "min",
      },
    ],
  },
];

export function getAgentSpec(key: string): AgentSpec | null {
  return AGENTS.find(a => a.key === key) ?? null;
}
