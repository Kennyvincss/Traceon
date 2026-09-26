// TODO: retry failed charges
// FIXME: currency is hard-coded
export async function charge(amount: number) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('missing key');
  return { amount, currency: 'usd', db: process.env.DATABASE_URL };
}

export class Invoice {}
