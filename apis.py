import logging
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response


logger = logging.getLogger(__name__)

from .serializers import StripeIntantSerializers
from .serializers import AfterPaymentUserCreationSerializers
from .serializers import EnrollTrainingSerializers

from .models import StripePaymentIntant

from decimal import Decimal

import stripe


class LabourCarePaymentApis:

    # For normal payments it works perfectly
    class StripePaymentIntent(generics.RetrieveAPIView):
        permission_classes = (AllowAny, )
        serializer_class = StripeIntantSerializers

        def post(self, request, *args, **kwargs):
            serializer = self.serializer_class(data=request.data)
            if serializer.is_valid():
                amount = int(Decimal(serializer.validated_data['amount']) * 100)
                email = serializer.validated_data['email']
                first_name = serializer.validated_data['first_name']
                last_name = serializer.validated_data['last_name']
                intant_for = serializer.validated_data['intant_for']
                try:
                    currency_type = "AUD"
                    intent = stripe.PaymentIntent.create(
                        amount=amount,
                        currency=currency_type,
                        automatic_payment_methods={ 'enabled': True, },
                        receipt_email=email,
                        description=intant_for,
                        metadata={ 
                            'name': f"{first_name} {last_name}"
                        }
                    )
                    serializer.save(intant=intent['client_secret'])
                    return Response({"success_message": intent['client_secret']})
                except Exception as e:
                    return Response({"error_message": str(e)})
            return Response({"error_message": serializer.errors})


    class EnrollTrainingPaymentComplete(generics.RetrieveAPIView):
        permission_classes = (AllowAny, )
        serializer_class = EnrollTrainingSerializers

        def post(self, request, *args, **kwargs):
            try:
                serializer = self.serializer_class(data=request.data)
                if not serializer.is_valid():
                    return Response({"error_message": serializer.errors}, status=400)
                
                payment_confirm_id = serializer.validated_data['payment_confirm_id']
                paid_by = serializer.validated_data["paid_by"]
                amount = serializer.validated_data['amount']
                payment_comfirmed = False
                                
                # The amount from frontend already has all discounts applied
                # Do NOT re-apply subscription discount here - it should be calculated on frontend
                expected_amount_cents = int(Decimal(str(amount)) * 100)
                
                # Validate payment with provider
                if paid_by == "stripe":
                    try:
                        check_stripe_payment = stripe.PaymentIntent.retrieve(payment_confirm_id).to_dict()
                        amount_received = int(check_stripe_payment.get("amount_received", 0))
                        if amount_received == expected_amount_cents:
                            payment_comfirmed = True
                        else:
                            pass
                    except Exception as e:
                        return Response({"error_message": f"Failed to verify Stripe payment: {str(e)}"}, status=400)
                elif paid_by == "cupon":
                    payment_comfirmed = True
                
                # Payment confirmed - proceed with enrollment
                
                if payment_comfirmed:
                    pass
            except Exception as e:
                logger.error(f"[ENROLLMENT] Unexpected error in enrollment process: {str(e)}", exc_info=True)
                return Response({
                    "error_message": f"Unexpected error: {str(e)}"
                }, status=500)


    # For subscription I am using this
    class StripeSubscriptionCheckout(generics.GenericAPIView):
        permission_classes = (AllowAny,)
        serializer_class = StripeIntantSerializers

        def post(self, request, *args, **kwargs):
            serializer = self.get_serializer(data=request.data)
            if not serializer.is_valid():
                return Response({"error_message": serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
            
            price_id = serializer.validated_data.get('price_id')
            email = serializer.validated_data['email']
            first_name = serializer.validated_data["first_name"]
            last_name = serializer.validated_data["last_name"]

            try:
                existing_customers = stripe.Customer.list(email=email, limit=1)
                if existing_customers.data:
                    customer = existing_customers.data[0]
                else:
                    customer = stripe.Customer.create(
                        email=email,
                        name=f"{first_name} {last_name}".strip()
                    )
                subs = stripe.Subscription.list(
                    customer=customer.id,
                    status="all",
                    limit=10
                )
                active_subs = [
                    sub for sub in subs.data
                    if sub.status in ["active", "trialing", "past_due"]
                ]
                active_sub = active_subs[0] if active_subs else None

                # Cancel any other active subscriptions IMMEDIATELY to avoid double charging
                # When user changes plan, we want immediate cancellation, not at period end
                if len(active_subs) > 1:
                    for i, sub in enumerate(active_subs[1:], 1):
                        try:
                            stripe.Subscription.delete(sub.id)
                        except Exception as e:
                            pass

                if active_sub:
                    subscription_item_id = active_sub["items"]["data"][0].id
                    old_price_id = active_sub["items"]["data"][0].price.id
                    subscription = stripe.Subscription.modify(
                        active_sub.id,
                        items=[{
                            "id": subscription_item_id,
                            "price": price_id,
                        }],
                        proration_behavior="none",
                        billing_cycle_anchor="now",
                        payment_settings={
                            "save_default_payment_method": "on_subscription"
                        },
                        expand=["latest_invoice.payment_intent"]
                    )
                else:
                    subscription = stripe.Subscription.create(
                        customer=customer.id,
                        items=[{"price": price_id}],
                        payment_behavior="default_incomplete",
                        payment_settings={
                            "save_default_payment_method": "on_subscription"
                        },
                        expand=["latest_invoice.payment_intent"]
                    )

                # Extract latest_invoice from subscription response
                latest_invoice = getattr(subscription, 'latest_invoice', None)
                
                if not latest_invoice:
                     raise Exception("Subscription created but no invoice found.")
                
                # Get invoice ID (works with both Stripe objects and dicts)
                invoice_id = getattr(latest_invoice, 'id', None) or (latest_invoice.get('id') if isinstance(latest_invoice, dict) else None)
                
                # Get payment intent from invoice
                payment_intent = getattr(latest_invoice, "payment_intent", None)
                if not payment_intent and isinstance(latest_invoice, dict):
                    payment_intent = latest_invoice.get('payment_intent')
                
                # If still no payment intent, try to retrieve the full invoice
                if not payment_intent and invoice_id:
                    try:
                        latest_invoice = stripe.Invoice.retrieve(
                            invoice_id,
                            expand=['payment_intent']
                        )
                        payment_intent = getattr(latest_invoice, "payment_intent", None)
                        if not payment_intent and isinstance(latest_invoice, dict):
                            payment_intent = latest_invoice.get('payment_intent')
                    except Exception as e:
                        pass

                if not payment_intent:
                    # If there's no payment intent in the invoice, try to create one
                    amount_due = getattr(latest_invoice, 'amount_due', 0) or (latest_invoice.get('amount_due', 0) if isinstance(latest_invoice, dict) else 0)
                    if amount_due > 0:
                        # Create a payment intent for the pending amount
                        payment_intent = stripe.PaymentIntent.create(
                            customer=customer.id,
                            amount=amount_due,
                            currency="aud",
                            receipt_email=email
                        )
                        client_secret = payment_intent.client_secret
                    else:
                        # If amount due is 0 or no amount due, create a setup intent 
                        # for collecting payment method for future charges
                        setup_intent = stripe.SetupIntent.create(
                            customer=customer.id,
                            payment_method_types=["card"]
                        )
                        client_secret = setup_intent.client_secret
                else:
                    # Use the payment intent's client secret
                    client_secret = getattr(payment_intent, 'client_secret', None) or (payment_intent.get('client_secret') if isinstance(payment_intent, dict) else None)
                
                if not client_secret:
                    raise Exception("Failed to generate client secret for payment")
                
                # SAFEGUARD: Verify only ONE active subscription exists
                try:
                    final_check_subs = stripe.Subscription.list(
                        customer=customer.id,
                        status="active",
                        limit=10
                    )
                    active_count = len(final_check_subs.data)
                    if active_count > 1:
                        for sub in final_check_subs.data[1:]:
                            try:
                                stripe.Subscription.delete(sub.id)
                            except Exception as e:
                                pass
                    elif active_count == 1:
                        pass
                except Exception as e:
                    pass
                
                # Save the payment intent record (exclude write_only price_id field)
                # Create the instance directly without the price_id field
                data_to_save = {k: v for k, v in serializer.validated_data.items() if k != 'price_id'}
                StripePaymentIntant.objects.create(intant=client_secret, **data_to_save)
                
                # Ensure subscription_id and customer_id are valid
                if not subscription.id or not customer.id or not client_secret:
                    raise Exception("Failed to generate complete subscription data")
                
                return Response({
                    "subscription_id": subscription.id,
                    "customer_id": customer.id,
                    "client_secret": client_secret
                })
            except Exception as e:
                return Response({"error_message": str(e)}, status=status.HTTP_400_BAD_REQUEST)


    class SubscriptionPaymentComplete(generics.RetrieveAPIView):
        permission_classes = (AllowAny, )
        user_serializer_class = AfterPaymentUserCreationSerializers

        def post(self, request, *args, **kwargs):
            try:
                serializer = self.user_serializer_class(data=request.data)
                if not serializer.is_valid():
                    return Response({"error_message": serializer.errors})
                payment_confirm_id = serializer.validated_data['payment_confirm_id']
                try:
                    subscription = stripe.Subscription.retrieve(
                        payment_confirm_id,
                        expand=["latest_invoice.payment_intent"]
                    )
                    invoice = subscription.latest_invoice
                    payment_confirmed = invoice.status == "paid"

                except stripe.error.StripeError as e:
                    raise Exception(f"Stripe verification failed: {e.user_message or str(e)}")

                # Check if payment is confirmed before proceeding
                if payment_confirmed:
                    pass
                    # I just need a confirmation that the payment is confirmed
                else:
                    return Response({"error_message": "Payment Not Confirmed"}, status=status.HTTP_400_BAD_REQUEST)
            except Exception as e:
                logger.error(f"Subscription payment complete error: {str(e)}")
                return Response({"error_message": str(e)}, status=status.HTTP_400_BAD_REQUEST)
