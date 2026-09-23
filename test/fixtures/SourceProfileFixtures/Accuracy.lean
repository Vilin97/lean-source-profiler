import Lean
import SourceProfileFixtures.Imported

namespace SourceProfileFixtures

-- A two-tactic proof, comparable in shape to the NS meanField_add example.
theorem twoTactics (f : Nat → Nat) : (fun n => f n + 0) = f := by
  funext n
  exact Nat.add_zero (f n)

-- Repeated text must have different source ranges, even within one theorem.
theorem repeatedTactics : True ∧ True := by
  constructor
  · exact True.intro
  · exact True.intro

-- The enclosing tactic's range crosses physical lines.
theorem multilineTactic (n : Nat) : n = n := by
  exact
    Eq.trans
      (Eq.refl n)
      (Eq.refl n)

-- Emoji is four UTF-8 bytes / two UTF-16 code units. Greek is two bytes / one unit.
-- The actual emoji below precedes a tactic on the SAME line, catching byte offsets.
theorem unicodeColumns (α : Type) (x : α) : x = x := by
  /- 🦀 λ -/ exact Eq.refl x

-- An inner tactic is included in the outer have: do not sum their inclusive times.
theorem nestedTactics (n : Nat) : n = n := by
  have h : n = n := by
    exact Eq.refl n
  exact h

-- Reducing an imported definition happens at this use, not at its definition time.
theorem importedReduction (n : Nat) : importedAdd n 0 = n := by
  exact Eq.refl n

-- Deliberately creates nontrivial definitional reduction without Mathlib.
set_option maxRecDepth 4096 in
theorem reductionWork (n : Nat) : transparentIteration 200 n = n := by
  exact Eq.refl n

-- A definition reference should navigate to Imported.lean, with caller context.
theorem importedProof (n : Nat) : importedAdd n 0 = n := by
  exact importedAdd_zero n

end SourceProfileFixtures
