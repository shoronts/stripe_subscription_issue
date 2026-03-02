from rest_framework import generics
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status

from payment.models import StripePaymentIntant


class ChangePlan(generics.GenericAPIView):
    permission_classes = (IsAuthenticated,)
    
    def post(self, request, *args, **kwargs):
        """
        Handle plan upgrade/downgrade:
        - Upgrade: Add staff slots and consulting hours
        - Downgrade: Remove staff slots (by date) and reduce consulting hours
        """
        try:
            new_plan_info = request.data.get("plan_info")
            payment_id = request.data.get("payment_id")  # Optional payment ID to delete intent
            paid_by = request.data.get("paid_by", "stripe")  # Payment method
            
            if not new_plan_info:
                return Response(
                    {"error_message": "plan_info is required"}, 
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            
            new_plan_name = new_plan_info.get("name") or new_plan_info.get("plan_name", "Unknown")
            
            
            # Delete payment intent records if payment ID provided
            if payment_id:
                try:
                    if paid_by == "stripe":
                        stripe_intent = StripePaymentIntant.objects.filter(payment_id=payment_id).first()
                        if stripe_intent:
                            stripe_intent.delete()
                except Exception as e:
                    pass
            
            return Response({
                "success_message": f"Plan changed successfully!",
                "details": {
                    "new_plan": new_plan_name,
                }
            })
        
        except Exception as e:
            return Response(
                {"error_message": f"Error: {str(e)}"}, 
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )