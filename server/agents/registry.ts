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
    tools: [
      "searchPatient",
      "explainReport",
      "searchVault",
      "getWeather",
      "getLocalTime",
      "calendarToday",
    ],
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
  {
    key: "codage",
    name: "Hermès Codage",
    role: "Propose les codes CIM-10 et actes TARDOC à partir du compte rendu.",
    objectives: ["Aider au codage diagnostique et tarifaire"],
    tasks: ["Suggérer des codes CIM-10", "Suggérer des actes TARDOC"],
    tools: ["suggestBillingCodes"],
    access: ["report.read"],
    guardrails: [
      "Suggestion à valider par le médecin",
      "Ne facture ni ne transmet rien",
    ],
    kpis: [
      {
        key: "codageRuns",
        label: "Codages proposés",
        target: 1,
        unit: "",
        goal: "max",
      },
    ],
  },
  {
    key: "apprentissage",
    name: "Hermès Apprentissage",
    role: "Apprend des corrections du médecin et propose des fiches de référence.",
    objectives: [
      "Capitaliser les corrections récurrentes",
      "Améliorer les futurs CR",
    ],
    tasks: [
      "Comparer brouillon↔signé",
      "Repérer les patterns par modalité",
      "Proposer une fiche RAG",
    ],
    tools: ["proposeRagFiche"],
    access: ["report.read", "knowledge.read"],
    guardrails: [
      "N'écrit JAMAIS en base RAG sans validation humaine",
      "Aucune donnée patient dans la fiche (règle générale uniquement)",
      "N'apprend que d'un pattern récurrent (seuil)",
    ],
    kpis: [
      {
        key: "fichesProposed",
        label: "Fiches proposées",
        target: 1,
        unit: "",
        goal: "max",
      },
      {
        key: "fichesApproved",
        label: "Fiches approuvées",
        target: 1,
        unit: "",
        goal: "max",
      },
    ],
  },
  {
    key: "referent",
    name: "Hermès Référent",
    role: "Gère le carnet des médecins référents et le suivi des envois de CR.",
    objectives: [
      "Tenir un annuaire fiable",
      "Tracer les envois de comptes rendus",
    ],
    tasks: ["Gérer les contacts référents", "Envoyer le CR signé au référent"],
    tools: ["manageContacts", "sendReport"],
    access: ["report.read", "email.send"],
    guardrails: [
      "Jamais d'envoi sans signature du médecin",
      "Le carnet ne contient que des médecins référents (aucune donnée patient)",
    ],
    kpis: [
      {
        key: "envois",
        label: "CR envoyés au référent",
        target: 1,
        unit: "",
        goal: "max",
      },
    ],
  },
];

export function getAgentSpec(key: string): AgentSpec | null {
  return AGENTS.find(a => a.key === key) ?? null;
}
