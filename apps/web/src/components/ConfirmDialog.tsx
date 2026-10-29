import type { GeneratePlanResponse } from "@vd-creator/server";
import { confirmLabel } from "../generation.js";

export type ConfirmRequest = {
  plan: GeneratePlanResponse;
  /** True when the plan grew after the user approved an earlier one, so it is shown again. */
  changed: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** The confirm step of a paid generation: nothing runs until "Generate (N characters)". */
export function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const { plan } = request;
  const toGenerate = plan.plan.items.filter((i) => i.status === "to-generate").length;
  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">Paid generation</h2>
        {request.changed && (
          <p role="status">
            The scenario changed, and this generation now costs more than you approved. Nothing was
            generated. Check the new estimate.
          </p>
        )}
        <p>
          <strong>{plan.provider.id}</strong> charges for each generation. This generates{" "}
          {toGenerate} {toGenerate === 1 ? "item" : "items"} with an estimated{" "}
          {plan.plan.cost.characters} characters in {plan.plan.cost.requests}{" "}
          {plan.plan.cost.requests === 1 ? "request" : "requests"}.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={request.onCancel}>
            Cancel
          </button>
          <button type="button" className="primary warn" onClick={request.onConfirm}>
            {confirmLabel(plan)}
          </button>
        </div>
      </div>
    </div>
  );
}
