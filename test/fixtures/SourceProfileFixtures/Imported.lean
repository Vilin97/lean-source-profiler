/-
This declaration lives in a different module on purpose. An imported declaration
link must resolve here, not to its occurrence in the caller's printed trace.
-/
namespace SourceProfileFixtures

def importedAdd (n m : Nat) : Nat := n + m

def transparentIteration : Nat → Nat → Nat
  | 0, n => n
  | k + 1, n => transparentIteration k n

theorem importedAdd_zero (n : Nat) : importedAdd n 0 = n := rfl

end SourceProfileFixtures
