/**
 * Subscription plans. Edit these to change pricing tiers.
 * - maxVideoSec: longest video a user on this plan can submit
 * - monthlyTranslations: successful (or in-progress) jobs per calendar month (UTC)
 */
export const PLANS = {
  free: { name: "Free", maxVideoSec: 3 * 60, monthlyTranslations: 5 },
  pro: { name: "Pro", maxVideoSec: 30 * 60, monthlyTranslations: 200 },
  business: { name: "Business", maxVideoSec: 2 * 60 * 60, monthlyTranslations: 2000 },
};

export const DEFAULT_PLAN = "free";

export function getPlan(id) {
  return PLANS[id] ?? PLANS[DEFAULT_PLAN];
}
