import assert from "node:assert/strict";
import { test } from "node:test";
import { processingStage } from "../web/src/lib/processing-stage.js";

test("quadros mostram verde somente após a confirmação do callback", () => {
  for (const delivery_state of ["waiting", "sending", "failed"]) {
    assert.equal(
      processingStage({ state: "completed", attempts: 1 }, { delivery_state }),
      "processing",
    );
  }
  assert.equal(
    processingStage(
      { state: "completed", attempts: 1 },
      { delivery_state: "delivered" },
    ),
    "sent",
  );
  assert.equal(
    processingStage(
      { state: "pending", attempts: 0 },
      { delivery_state: "waiting" },
    ),
    "received",
  );
  assert.equal(
    processingStage(
      { state: "pending", attempts: 1 },
      { delivery_state: "waiting" },
    ),
    "processing",
  );
  assert.equal(
    processingStage(
      { state: "processing", attempts: 1 },
      { delivery_state: "waiting" },
    ),
    "processing",
  );
  assert.equal(
    processingStage(
      { state: "failed", attempts: 8 },
      { delivery_state: "failed" },
    ),
    "received",
  );
});
