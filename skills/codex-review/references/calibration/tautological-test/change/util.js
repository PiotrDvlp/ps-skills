export function isEligible(user) {
  if (user.vip) return true;
  return user.age >= 18 && user.active;
}
