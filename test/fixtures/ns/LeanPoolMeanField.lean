import LeanPool.NavierStokesAndEuler.NavierStokes.ActualCandidateAssembly

open NavierStokes
open NavierStokes.ActualCandidateConstruction
open NavierStokes.CorrectionInitialization.ActualPrimary

namespace SourceProfileFixtureLeanPool

theorem meanField_add_original (B N0 : ℕ) (degree : ℝ)
    (f g : ActualMeanPhysicalData.Scalar) :
    meanField B N0 degree (f + g) = meanField B N0 degree f + meanField B N0 degree g := by
  funext w
  exact congrFun ((meanAtlas B N0).physical_add standardRegion.carrier degree f g)
    (PhysicalMeanJetBounds.physicalPoint h w)

theorem meanField_add_explicit (B N0 : ℕ) (degree : ℝ)
    (f g : ActualMeanPhysicalData.Scalar) :
    meanField B N0 degree (f + g) = meanField B N0 degree f + meanField B N0 degree g := by
  funext w
  dsimp only [meanField, Function.comp_apply, Pi.add_apply]
  exact congrFun ((meanAtlas B N0).physical_add standardRegion.carrier degree f g)
    (PhysicalMeanJetBounds.physicalPoint h w)

end SourceProfileFixtureLeanPool

/-
Copyright (c) 2026 OpenAI. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: OpenAI
The upstream LICENSE named above is preserved here as LICENSES/Apache-2.0.txt.

SPDX-License-Identifier: Apache-2.0
Adapted through Lean Pool, commit bb74ee07fc23bc81358d75a9c40303e5e27fced8,
NavierStokesAndEuler/NavierStokes/ActualCandidateAssembly.lean, meanField_add.
Modified by Lean Source Profiler contributors: isolated imports/namespace,
renamed theorem, reformatted arguments, and an explicit-reduction comparison.
See THIRD_PARTY_NOTICES.md and LICENSES/Apache-2.0.txt at the repository root.
-/
