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
