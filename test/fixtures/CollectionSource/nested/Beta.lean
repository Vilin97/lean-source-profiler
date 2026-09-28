namespace CollectionSource

theorem beta : True ∧ True := by
  constructor
  · exact True.intro
  · exact True.intro

theorem multiline (n : Nat) : n = n := by
  exact
    Eq.trans
      (Eq.refl n)
      (Eq.refl n)

end CollectionSource
