import NavierStokes.ActualCandidateConstruction

open NavierStokes
open NavierStokes.ActualCandidateConstruction
open NavierStokes.CorrectionInitialization.ActualPrimary

namespace SourceProfileFixtureOai

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

end SourceProfileFixtureOai

/-
SPDX-License-Identifier: Apache-2.0
Adapted from OpenAI's NavierStokesAndEuler, commit
8937a8f4cbc7abaab5e9e97d1cc7f5d2319d9538, ActualCandidateConstruction.meanField_add.
Modified by Lean Source Profiler contributors: isolated imports/namespace,
renamed theorem, reformatted arguments, and an explicit-reduction comparison.
See THIRD_PARTY_NOTICES.md and LICENSES/Apache-2.0.txt at the repository root.
-/
