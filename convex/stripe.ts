import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import Stripe from 'stripe';
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

export const pay = action({
    args: {},
    handler: async (ctx) => {
        const clerkUser = await ctx.auth.getUserIdentity();
        const user = await ctx.runQuery(api.users.currentUser, {});

        if (!user || !clerkUser) {
            throw new Error("User not authenticated!");
        }

        if (!clerkUser.emailVerified) {
            throw new Error("User email not verified!");
        }

        const stripe = new Stripe(process.env.NEXT_STRIPE_SECRET_KEY!, {
            apiVersion: "2026-09-30.endive"
        });

        const domain = process.env.NEXT_PUBLIC_HOSTING_URL!;

        const session: Stripe.Response<Stripe.Checkout.Session> = await stripe.checkout.sessions.create(
            {
                mode: "subscription",
                line_items: [
                    {
                        price: process.env.STRIPE_ONE_TIME_PRICE_ID!,
                        quantity: 1,
                    },
                ],
                customer_email: clerkUser.email,
                metadata: {
                    userId: user._id,
                },
                success_url: `${domain}`,
                cancel_url: `${domain}`,
            }
        );
        return session.url;
    },
});


type Metadata = {
    userId: Id<"users">;
}

export const fulfill = internalAction({
    args: { signature: v.string(), payload: v.string() },
    handler: async ({ runQuery, runMutation }, { signature, payload }) => {
        const stripe = new Stripe(process.env.NEXT_STRIPE_SECRET_KEY!, {
            apiVersion: "2026-09-30.endive",
        });

        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string;
        try {
            const event = await stripe.webhooks.constructEventAsync(
                payload,
                signature,
                webhookSecret
            );
            const completedEvent = event.data.object as Stripe.Checkout.Session & {
                metadata: Metadata;
            }

            if (event.type === "checkout.session.completed") {
                const subscription = await stripe.subscriptions.retrieve(
                    completedEvent.subscription as string
                )

                const userId = completedEvent.metadata.userId;

                await runMutation(internal.users.updateSubscription, {
                    userId,
                    subscriptionId: subscription.id,
                    endsOn: (getSubscriptionPeriodEnd(subscription)) * 1000,
                });
            }

            if (event.type === "invoice.payment_succeeded") {
                const subscription = await stripe.subscriptions.retrieve(
                    (getInvoiceSubscription(completedEvent)) as string
                );

                await runMutation(internal.users.updateSubscriptionById, {
                    subscriptionId: subscription.id,
                    endsOn: (getSubscriptionPeriodEnd(subscription)) * 1000,
                });
            }

            return { success: true };
        } catch (error) {
            console.log(error);
            return { success: false, error: (error as { message: string }).message };
        }
    },
});