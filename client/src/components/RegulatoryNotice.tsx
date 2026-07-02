import { useState, useEffect } from "react";

const STORAGE_KEY = "mediview_regulatory_notice_v1";

/**
 * Bandeau réglementaire CE-MDR/IVD affiché une fois par session.
 * MediView est un logiciel de visualisation diagnostique non certifié CE/MDR
 * (classe IIa/IIb). Tout compte-rendu IA est une aide, pas un diagnostic.
 */
export default function RegulatoryNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const dismissed = sessionStorage.getItem(STORAGE_KEY);
    if (!dismissed) setVisible(true);
  }, []);

  function dismiss() {
    sessionStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="reg-notice-title"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 px-4"
    >
      <div className="max-w-md w-full rounded-xl border border-yellow-500/40 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-start gap-3 mb-3">
          <span className="text-yellow-400 text-2xl leading-none select-none">
            ⚠
          </span>
          <h2
            id="reg-notice-title"
            className="text-base font-semibold text-yellow-300"
          >
            Avertissement réglementaire
          </h2>
        </div>
        <div className="space-y-2 text-sm text-zinc-300 leading-relaxed">
          <p>
            <strong>MediView</strong> est un logiciel de visualisation
            d'imagerie médicale à usage professionnel. Il n'est{" "}
            <strong>pas certifié</strong> au titre du Règlement (UE) 2017/745
            (MDR) ni du règlement suisse sur les dispositifs médicaux (RDM).
          </p>
          <p>
            Les analyses et comptes rendus générés par l'IA constituent une{" "}
            <strong>aide à la décision uniquement</strong>. Ils ne remplacent
            pas l'évaluation clinique d'un médecin qualifié et ne doivent pas
            être utilisés seuls comme base diagnostique.
          </p>
          <p className="text-zinc-500 text-xs">
            En continuant, vous reconnaissez avoir pris connaissance de cet
            avertissement.
          </p>
        </div>
        <button
          onClick={dismiss}
          className="mt-4 w-full rounded-lg bg-yellow-500 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-yellow-400 transition-colors"
        >
          Compris — accéder au visualiseur
        </button>
      </div>
    </div>
  );
}
