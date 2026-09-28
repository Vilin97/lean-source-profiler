namespace CollectionSource

theorem alpha (n : Nat) : n = n := by
  exact Eq.refl n

theorem two_steps (f : Nat → Nat) : (fun n => f n + 0) = f := by
  funext n
  exact Nat.add_zero (f n)

end CollectionSource
