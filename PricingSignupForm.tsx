import { useState, useCallback, useEffect, useRef } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2, CheckCircle, AlertCircle, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useToast } from "@/hooks/use-toast";
import { useLocationLookup } from "@/hooks/useLocationLookup";
import { API_BASE_URL } from "@/lib/api";
import { setEncryptedCookie } from "@/lib/cookies";
import { useAuth } from "@/contexts/AuthContext";
import { changePlan } from "@/lib/paymentApi";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";

// Get Stripe publishable key
// @ts-ignore - Vite injects this at build time
const STRIPE_KEY = typeof __ENV_STRIPE_PUBLISHABLE_KEY__ !== 'undefined' 
  ? __ENV_STRIPE_PUBLISHABLE_KEY__ 
  : 'pk_test_placeholder';
const stripePromise = loadStripe(STRIPE_KEY);

// Normalize backend error payloads so we never pass objects into React children
const formatErrorMessage = (error: any): string => {
  if (!error) return "An unexpected error occurred";
  if (typeof error === "string") return error;

  // If the backend returns { error_message: ... } recursively format it
  if (typeof error === "object" && "error_message" in error) {
    return formatErrorMessage((error as any).error_message);
  }

  if (typeof error === "object") {
    try {
      // Try to flatten common Django-style error objects
      return Object.values(error)
        .flat()
        .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
        .join(", ");
    } catch (_e) {
      return JSON.stringify(error);
    }
  }

  return String(error);
};

interface PricingSignupFormProps {
  isOpen: boolean;
  onClose: () => void;
  plan: {
    name: string;
    monthlyPrice: number;
    yearlyPrice: number;
    priceIdMonthly?: string;
    priceIdYearly?: string;
    priceId?: string; // fallback if a single price ID is provided
  };
  billingPeriod: "monthly" | "yearly";
  currentUser?: any; // Optional user object for logged-in users
}

// Stripe Payment Form Component
function StripePaymentForm({
  plan,
  billingPeriod,
  formData,
  paymentId,
  clientSecret,
  subscriptionId,
  onSuccess,
  onError,
  onCancel,
  currentUser,
  authToken,
  customerId,
}: {
  plan: { name: string; monthlyPrice: number; yearlyPrice: number };
  billingPeriod: "monthly" | "yearly";
  formData: any;
  paymentId: string;
  clientSecret: string;
  subscriptionId: string | null;
  onSuccess: (message: string, token?: string, userData?: any) => void;
  onError: (message: string) => void;
  onCancel: () => void;
  currentUser?: any;
  authToken?: string;
  customerId?: string | null;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const price = billingPeriod === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);

    try {
      // Determine if we're using PaymentIntent or SetupIntent based on the client secret
      const isSetupIntent = clientSecret?.includes('seti_');
      
      let paymentMethodId: string | undefined;
      let error: any;

      if (isSetupIntent) {
        // Handle SetupIntent (for subscriptions without immediate payment)
        const result = await stripe.confirmSetup({
          elements,
          confirmParams: {
            return_url: window.location.href,
          },
          redirect: "if_required",
        });
        
        error = result.error;
        paymentMethodId = result.setupIntent?.payment_method as string | undefined;
      } else {
        // Handle PaymentIntent (for immediate payment)
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: {
            return_url: window.location.href,
          },
          redirect: "if_required",
        });
        
        error = result.error;
        paymentMethodId = result.paymentIntent?.payment_method as string | undefined;
      }

      if (error) {
        onError(error.message || "Payment failed");
        setIsProcessing(false);
        return;
      }

      if (!paymentMethodId) {
        onError("Payment method not found. Please try again.");
        setIsProcessing(false);
        return;
      }

      if (subscriptionId && paymentMethodId) {
        // Complete registration on backend
        try {
          const response = await fetch(`${API_BASE_URL}/payments/subscription-payment-complete/`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              first_name: formData.firstName,
              last_name: formData.lastName,
              email: formData.email,
              phone_number: formData.phone,
              location: formData.suburb,
              username: formData.username,
              password: formData.password || "",
              abn: formData.abn || "",
              aggreed: true,
              amount: String(price),
              payment_confirm_id: subscriptionId,
              payment_method_id: paymentMethodId,
              paid_by: "stripe",
              payment_id: paymentId,
              paid_for: billingPeriod,
              subscription_type: billingPeriod,
              subscription_details: JSON.stringify({
                name: plan.name,
                price: String(price),
                pack_for: billingPeriod,
                partner_type: plan.name.toLowerCase().includes("independent") ? "independent" : "business",
                free_consulting_hour_month: billingPeriod === "yearly" ? 12 : 1,
                can_add: plan.name.toLowerCase().includes("growth") 
                  ? (billingPeriod === "yearly" ? 5 : 2)
                  : 0,
              }),
            }),
          });

          if (response.ok) {
            const data = await response.json();
            
            // If user is logged in, call changePlan API
            if (currentUser && authToken) {
              try {
                const planInfo = {
                  name: plan.name,
                  pack_for: billingPeriod,
                  partner_type: plan.name.toLowerCase().includes("independent") ? "independent" : "business",
                  free_consulting_hour_month: billingPeriod === "yearly" ? 12 : 1,
                  can_add: plan.name.toLowerCase().includes("growth") 
                    ? (billingPeriod === "yearly" ? 5 : 2)
                    : 0,
                  price: billingPeriod === "yearly" ? plan.yearlyPrice : plan.monthlyPrice,
                  additional_cost: plan.name.toLowerCase().includes("growth") ? (billingPeriod === "yearly" ? 200 : 20) : 0,
                  free_training: plan.name.toLowerCase().includes("growth") ? (billingPeriod === "yearly" ? 5 : 0) : 0,
                  traning_discount: billingPeriod === "yearly" ? 50 : 20,
                  hour_discount_percent: 15,
                };
                
                const changePlanResult = await changePlan({ 
                  plan_info: planInfo,
                  payment_id: paymentId,
                  paid_by: "stripe" 
                }, authToken);
                onSuccess(changePlanResult.success_message + " " + (changePlanResult.details?.staff_change || "") + " " + (changePlanResult.details?.hours_change || ""));
              } catch (err: any) {
                onError(err.message || "Failed to update plan");
              }
            } else if (data.success_message && data.token && data.user) {
              onSuccess(data.success_message, data.token, data.user);
            } else if (data.error_message) {
              onError(formatErrorMessage(data.error_message));
            } else {
              onError("Unexpected response from server");
            }
          } else {
            const error = await response.json();
            onError(formatErrorMessage(error.error_message || error));
          }
        } catch (err: any) {
          onError(err.message || "An error occurred during registration");
        }
      } else {
        onError("Payment was not completed. Please try again.");
      }
    } catch (err: any) {
      onError(err.message || "An error occurred during payment");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-muted/50 p-4 rounded-xl">
        <PaymentElement
          onReady={() => setIsReady(true)}
          options={{
            layout: "tabs",
          }}
        />
      </div>

      <div className="flex gap-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isProcessing}
          className="flex-1"
        >
          Back
        </Button>
        <Button
          type="submit"
          variant="healthcare"
          disabled={!stripe || !elements || isProcessing || !isReady}
          className="flex-1"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            `Pay $${price}`
          )}
        </Button>
      </div>
    </form>
  );
}

const PricingSignupForm = ({ isOpen, onClose, plan, billingPeriod, currentUser }: PricingSignupFormProps) => {
  const { toast } = useToast();
  const { token } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // If user is logged in, skip form and go directly to payment
  const initialStep = currentUser ? "payment" : "form";
  const [step, setStep] = useState<"form" | "payment">(initialStep);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string>("");
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  // Location autocomplete
  const { suggestions: locationSuggestions, isLoading: isLoadingLocation, searchLocation } = useLocationLookup();
  const [showLocationDropdown, setShowLocationDropdown] = useState(false);
  const locationDropdownRef = useRef<HTMLDivElement>(null);

  // Validation state
  const [usernameValidation, setUsernameValidation] = useState<{ isValid: boolean; message: string }>({ isValid: true, message: "" });
  const [emailValidation, setEmailValidation] = useState<{ isValid: boolean; message: string }>({ isValid: true, message: "" });
  const [abnValidation, setAbnValidation] = useState<{ isValid: boolean; message: string }>({ isValid: true, message: "" });
  const [isValidatingUsername, setIsValidatingUsername] = useState(false);
  const [isValidatingEmail, setIsValidatingEmail] = useState(false);
  const [isValidatingABN, setIsValidatingABN] = useState(false);

  // Password strength state
  const [passwordStrength, setPasswordStrength] = useState<{ score: number; label: string; color: string }>({ score: 0, label: "Weak", color: "bg-red-500" });
  
  // Pre-fill form data if user is logged in
  const [formData, setFormData] = useState({
    firstName: currentUser?.first_name || "",
    lastName: currentUser?.last_name || "",
    email: currentUser?.email || "",
    phone: currentUser?.phone_number || "",
    suburb: currentUser?.location || "",
    username: currentUser?.username || "",
    password: "",
    confirmPassword: "",
    abn: currentUser?.abn || "",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Debounce timer refs
  const usernameTimerRef = useRef<NodeJS.Timeout>();
  const emailTimerRef = useRef<NodeJS.Timeout>();
  const abnTimerRef = useRef<NodeJS.Timeout>();

  // Validate ABN format (11 digits, Australian Business Number)
  const validateABNFormat = (abn: string): boolean => {
    const abnDigits = abn.replace(/\D/g, "");
    if (abnDigits.length !== 11) return false;

    // ABN checksum validation (weighted digit algorithm)
    const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
    const abnArray = abnDigits.split("").map(Number);
    const firstDigit = abnArray[0] - 1;

    let sum = (firstDigit * weights[0]) + abnArray.slice(1).reduce((acc, digit, i) => {
      return acc + (digit * weights[i + 1]);
    }, 0);

    return sum % 89 === 0;
  };

  // Validate ABN
  const validateABN = useCallback(async (abn: string) => {
    if (!abn) {
      setAbnValidation({ isValid: true, message: "" });
      return;
    }

    setIsValidatingABN(true);

    const formattedABN = abn.replace(/\D/g, "");

    // Check format
    if (!validateABNFormat(formattedABN)) {
      setAbnValidation({ isValid: false, message: "Invalid ABN format (must be 11 digits)" });
      setIsValidatingABN(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/theme/varify-abn/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ abn: parseInt(formattedABN) }),
      });

      const data = await response.json();

      if (data.success_message) {
        setAbnValidation({ isValid: true, message: "ABN is valid" });
      } else if (data.error_message) {
        setAbnValidation({ isValid: false, message: formatErrorMessage(data.error_message) || "Invalid ABN" });
      }
    } catch (error) {
      // If API fails but format is valid, allow it
      if (validateABNFormat(formattedABN)) {
        setAbnValidation({ isValid: true, message: "ABN format is valid" });
      } else {
        setAbnValidation({ isValid: false, message: "Error validating ABN" });
      }
    } finally {
      setIsValidatingABN(false);
    }
  }, []);

  // Validate username
  const validateUsername = useCallback(async (username: string) => {
    if (!username) {
      setUsernameValidation({ isValid: true, message: "" });
      return;
    }

    setIsValidatingUsername(true);

    try {
      const response = await fetch(`${API_BASE_URL}/users/is-valid-username-email/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email_username: username.toLowerCase() }),
      });

      const data = await response.json();

      if (data.error_message) {
        setUsernameValidation({ isValid: false, message: "Username already taken" });
      } else {
        setUsernameValidation({ isValid: true, message: "Username available" });
      }
    } catch (error) {
      setUsernameValidation({ isValid: false, message: "Error checking username" });
    } finally {
      setIsValidatingUsername(false);
    }
  }, []);

  // Validate email
  const validateEmail = useCallback(async (email: string) => {
    if (!email) {
      setEmailValidation({ isValid: true, message: "" });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailValidation({ isValid: false, message: "Invalid email format" });
      setIsValidatingEmail(false);
      return;
    }

    setIsValidatingEmail(true);

    try {
      const response = await fetch(`${API_BASE_URL}/users/is-valid-username-email/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email_username: email.toLowerCase() }),
      });

      const data = await response.json();

      if (data.error_message) {
        setEmailValidation({ isValid: false, message: "Email already registered" });
      } else {
        setEmailValidation({ isValid: true, message: "Email available" });
      }
    } catch (error) {
      setEmailValidation({ isValid: false, message: "Error checking email" });
    } finally {
      setIsValidatingEmail(false);
    }
  }, []);

  // Calculate password strength
  const calculatePasswordStrength = (password: string) => {
    let score = 0;
    if (password.length >= 8) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^a-zA-Z\d]/.test(password)) score++;

    const strengthLevels = [
      { score: 0, label: "Weak", color: "bg-red-500" },
      { score: 1, label: "Fair", color: "bg-yellow-500" },
      { score: 2, label: "Good", color: "bg-blue-500" },
      { score: 3, label: "Strong", color: "bg-green-500" },
      { score: 4, label: "Very Strong", color: "bg-green-600" },
    ];

    return strengthLevels[score];
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    
    // Clear error when user starts typing
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: "" }));
    }

    // Debounced validation
    if (name === "username") {
      clearTimeout(usernameTimerRef.current);
      usernameTimerRef.current = setTimeout(() => {
        validateUsername(value);
      }, 500);
    } else if (name === "email") {
      clearTimeout(emailTimerRef.current);
      emailTimerRef.current = setTimeout(() => {
        validateEmail(value);
      }, 500);
    } else if (name === "abn") {
      clearTimeout(abnTimerRef.current);
      abnTimerRef.current = setTimeout(() => {
        validateABN(value);
      }, 500);
    } else if (name === "password") {
      setPasswordStrength(calculatePasswordStrength(value));
    } else if (name === "suburb") {
      if (value) {
        searchLocation(value);
        setShowLocationDropdown(true);
      } else {
        setShowLocationDropdown(false);
      }
    }
  };

  const handleLocationSelect = (location: string) => {
    setFormData(prev => ({
      ...prev,
      suburb: location,
    }));
    setShowLocationDropdown(false);
  };

  const generatePaymentId = () => {
    return `PRICING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    const requiresAbn = plan.name.toLowerCase().includes("growth");
    
    if (!formData.firstName.trim()) newErrors.firstName = "First name is required";
    if (!formData.lastName.trim()) newErrors.lastName = "Last name is required";
    if (!formData.email.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = "Invalid email address";
    } else if (!emailValidation.isValid) {
      newErrors.email = emailValidation.message || "Email validation failed";
    }
    if (!formData.phone.trim()) newErrors.phone = "Phone number is required";
    if (!formData.suburb.trim()) newErrors.suburb = "Suburb/state/postcode is required";
    if (!formData.username.trim()) {
      newErrors.username = "Username is required";
    } else if (!usernameValidation.isValid) {
      newErrors.username = usernameValidation.message || "Username validation failed";
    }
    // Only validate password for new users
    if (!currentUser) {
      if (!formData.password) {
        newErrors.password = "Password is required";
      } else if (formData.password.length < 8) {
        newErrors.password = "Password must be at least 8 characters";
      }
      if (formData.password !== formData.confirmPassword) {
        newErrors.confirmPassword = "Passwords do not match";
      }
    }
    if (requiresAbn && !formData.abn.trim()) {
      newErrors.abn = "ABN is required";
    } else if (formData.abn.trim() && !abnValidation.isValid) {
      newErrors.abn = abnValidation.message || "ABN validation failed";
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      toast({
        description: "Please fix validation errors before continuing",
        variant: "destructive",
      });
      return;
    }

    // Generate payment ID
    const payId = generatePaymentId();
    setPaymentId(payId);

    // Initialize Stripe payment directly
    setIsSubmitting(true);
    try {
      const price = billingPeriod === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
      const priceId = billingPeriod === "yearly" ? (plan.priceIdYearly || plan.priceId) : (plan.priceIdMonthly || plan.priceId);
      
      if (!priceId || priceId.includes("placeholder")) {
        toast({
          description: "Stripe price_id is not configured. Please contact support or configure Stripe price IDs in your environment variables.",
          variant: "destructive",
        });
        setIsSubmitting(false);
        return;
      }

      const response = await fetch(`${API_BASE_URL}/payments/stripe-subscription-checkout/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          first_name: formData.firstName,
          last_name: formData.lastName,
          username: formData.username,
          email: formData.email,
          phone_number: formData.phone,
          location: formData.suburb,
          amount: String(price),
          intant_for: `${plan.name} - ${billingPeriod} subscription`,
          payment_id: payId,
          price_id: priceId,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        try {
          const errorData = JSON.parse(errorText);
          throw new Error(errorData.error_message || `HTTP ${response.status}: ${response.statusText}`);
        } catch (e) {
          throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText.substring(0, 100)}`);
        }
      }

      const data = await response.json();
      if (data.error_message) {
        toast({
          description: formatErrorMessage(data.error_message) || "Failed to initialize payment",
          variant: "destructive",
        });
        setIsSubmitting(false);
        return;
      }

      // Validate response contains required fields
      if (!data.client_secret || !data.subscription_id || !data.customer_id) {
        throw new Error("Invalid response from payment server: missing client_secret, subscription_id, or customer_id");
      }
      
      setClientSecret(data.client_secret);
      setSubscriptionId(data.subscription_id);
      setCustomerId(data.customer_id);
      setStep("payment");
    } catch (error: any) {
      toast({
        description: formatErrorMessage(error?.message || error),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePaymentSuccess = (message: string, token?: string, userData?: any) => {
    toast({
      description: message,
    });
    
    // Only store auth token for new registrations (not for logged-in users)
    if (!currentUser && token && userData) {
      try {
        // Store token in encrypted cookie (same as login flow)
        setEncryptedCookie("labourcare_token", token);
        
        // Store user data in localStorage (same as login flow)
        const userDataToStore = {
          id: userData.id,
          username: userData.username,
          email: userData.email,
          first_name: userData.first_name,
          last_name: userData.last_name,
        };
        localStorage.setItem("labourcare_user", JSON.stringify(userDataToStore));
        
        // Store user type and role info
        setEncryptedCookie("labourcare_user_type", "client");
        // Determine if independent_partner or business_partner based on subscription plan
        const partnerRole = formData.abn ? "business_partner" : "independent_partner";
        setEncryptedCookie("labourcare_client_type", partnerRole);
      } catch (e) {
      }
    }
    
    // Reset form (only for non-logged-in users)
    if (!currentUser) {
      setFormData({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        suburb: "",
        username: "",
        password: "",
        confirmPassword: "",
        abn: "",
      });
    }
    setStep(currentUser ? "payment" : "form");
    onClose();
    
    // For logged-in users, redirect to billing page; for new registrations, redirect to app dashboard
    setTimeout(() => {
      if (currentUser) {
        window.location.href = "/app/billing";
      } else {
        window.location.href = "/app";
      }
    }, 1500);
  };

  const handlePaymentError = (message: string) => {
    toast({
      description: message,
      variant: "destructive",
    });
  };

  const handleCancel = () => {
    if (step === "payment") {
      // For logged-in users, close the modal; for new users, go back to form
      if (currentUser) {
        onClose();
      } else {
        setStep("form");
      }
    } else {
      onClose();
    }
  };

  // Close location dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (locationDropdownRef.current && !locationDropdownRef.current.contains(event.target as Node)) {
        setShowLocationDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Generate payment ID for logged-in users on mount
  useEffect(() => {
    if (currentUser && isOpen && !paymentId) {
      const payId = generatePaymentId();
      setPaymentId(payId);
    }
  }, [currentUser, isOpen, paymentId]);

  // Reset step when dialog closes/opens
  useEffect(() => {
    if (isOpen) {
      setStep(currentUser ? "payment" : "form");
    }
  }, [isOpen, currentUser]);
  
  // Initialize payment for logged-in users when dialog opens
  useEffect(() => {
    if (isOpen && currentUser && step === "payment" && !clientSecret) {
      const initializePayment = async () => {
        setIsSubmitting(true);
        try {
          const payId = paymentId || generatePaymentId();
          if (!paymentId) {
            setPaymentId(payId);
          }
          const price = billingPeriod === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
          const priceId = billingPeriod === "yearly" ? (plan.priceIdYearly || plan.priceId) : (plan.priceIdMonthly || plan.priceId);
          
          if (!priceId || priceId.includes("placeholder")) {
            toast({
              description: "Stripe price_id is not configured. Please contact support or configure Stripe price IDs in your environment variables.",
              variant: "destructive",
            });
            setIsSubmitting(false);
            return;
          }

          const response = await fetch(`${API_BASE_URL}/payments/stripe-subscription-checkout/`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              first_name: currentUser.first_name,
              last_name: currentUser.last_name,
              username: currentUser.username,
              email: currentUser.email,
              phone_number: currentUser.phone_number,
              location: currentUser.location,
              amount: String(price),
              intant_for: `${plan.name} - ${billingPeriod} subscription`,
              payment_id: payId,
              price_id: priceId,
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            try {
              const errorData = JSON.parse(errorText);
              throw new Error(errorData.error_message || `HTTP ${response.status}: ${response.statusText}`);
            } catch (e) {
              throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText.substring(0, 100)}`);
            }
          }

          const data = await response.json();
          if (data.error_message) {
            toast({
              description: formatErrorMessage(data.error_message) || "Failed to initialize payment",
              variant: "destructive",
            });
            setIsSubmitting(false);
            return;
          }

          if (!data.client_secret || !data.subscription_id || !data.customer_id) {
            throw new Error("Invalid response from payment server: missing client_secret, subscription_id, or customer_id");
          }
          
          setClientSecret(data.client_secret);
          setSubscriptionId(data.subscription_id);
          setCustomerId(data.customer_id);
        } catch (error: any) {
          toast({
            description: formatErrorMessage(error?.message || error),
            variant: "destructive",
          });
        } finally {
          setIsSubmitting(false);
        }
      };
      
      initializePayment();
    }
  }, [isOpen, currentUser, step, clientSecret, paymentId, plan, billingPeriod, toast]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent 
        className="max-w-4xl p-0 gap-0 overflow-hidden max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <VisuallyHidden>
          <DialogTitle>
            {currentUser ? `Subscribe to ${plan.name}` : `Sign up for ${plan.name}`}
          </DialogTitle>
          <DialogDescription>
            {currentUser 
              ? `Select a payment method to upgrade to the ${plan.name} plan.`
              : `Complete your registration for the ${plan.name} plan. Fill in your details and select a payment method to get started.`
            }
          </DialogDescription>
        </VisuallyHidden>
        
        {step === "form" && (
          <div className="grid lg:grid-cols-[1fr,320px]">
            {/* Form Section */}
            <div className="p-8">
              <button 
                onClick={onClose}
                className="flex items-center gap-2 text-primary hover:text-primary/80 transition-colors mb-6 text-sm font-medium"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              <form onSubmit={handleSubmit} className="space-y-8">
                {/* Personal Details */}
                <div>
                  <h3 className="font-semibold text-xl text-healthcare-text mb-4">Personal Details</h3>
                  <div className="space-y-4">
                    <div>
                      <input
                        type="text"
                        name="firstName"
                        placeholder="First Name"
                        value={formData.firstName}
                        onChange={handleChange}
                        className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                          errors.firstName ? "border-destructive" : "border-border"
                        }`}
                      />
                      {errors.firstName && <p className="text-destructive text-sm mt-1">{errors.firstName}</p>}
                    </div>
                    <div>
                      <input
                        type="text"
                        name="lastName"
                        placeholder="Last Name"
                        value={formData.lastName}
                        onChange={handleChange}
                        className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                          errors.lastName ? "border-destructive" : "border-border"
                        }`}
                      />
                      {errors.lastName && <p className="text-destructive text-sm mt-1">{errors.lastName}</p>}
                    </div>
                  </div>
                </div>

                {/* Contact Details */}
                <div>
                  <h3 className="font-serif text-xl text-healthcare-text mb-4">Contact Details</h3>
                  <div className="space-y-4">
                    <div>
                      <div className="relative">
                        <input
                          type="email"
                          name="email"
                          placeholder="Email address"
                          value={formData.email}
                          onChange={handleChange}
                          className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                            errors.email || !emailValidation.isValid ? "border-destructive" : "border-border"
                          }`}
                        />
                        {isValidatingEmail && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-primary" />}
                        {!isValidatingEmail && emailValidation.isValid && emailValidation.message && (
                          <CheckCircle className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                        )}
                        {!isValidatingEmail && !emailValidation.isValid && emailValidation.message && (
                          <AlertCircle className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-destructive" />
                        )}
                      </div>
                      {errors.email && <p className="text-destructive text-sm mt-1">{errors.email}</p>}
                      {!errors.email && emailValidation.message && (
                        <p className={`text-sm mt-1 ${emailValidation.isValid ? "text-green-500" : "text-destructive"}`}>
                          {emailValidation.message}
                        </p>
                      )}
                    </div>
                    <div>
                      <input
                        type="tel"
                        name="phone"
                        placeholder="Phone Number"
                        value={formData.phone}
                        onChange={handleChange}
                        className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                          errors.phone ? "border-destructive" : "border-border"
                        }`}
                      />
                      {errors.phone && <p className="text-destructive text-sm mt-1">{errors.phone}</p>}
                    </div>
                    <div className="relative" ref={locationDropdownRef}>
                      <div className="relative">
                        <input
                          type="text"
                          name="suburb"
                          placeholder="Suburb/state/postcode"
                          value={formData.suburb}
                          onChange={handleChange}
                          autoComplete="off"
                          className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                            errors.suburb ? "border-destructive" : "border-border"
                          }`}
                        />
                        {isLoadingLocation && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-primary" />}
                      </div>
                      {errors.suburb && <p className="text-destructive text-sm mt-1">{errors.suburb}</p>}
                      
                      {showLocationDropdown && locationSuggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-2 bg-card border border-border rounded-xl shadow-lg z-50 max-h-60 overflow-y-auto">
                          {locationSuggestions.map((suggestion, index) => (
                            <button
                              key={index}
                              type="button"
                              onClick={() => handleLocationSelect(suggestion)}
                              className="w-full text-left px-4 py-3 hover:bg-secondary border-b last:border-b-0 transition-colors"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Account Details */}
                <div>
                  <h3 className="font-serif text-xl text-healthcare-text mb-4">Account Details</h3>
                  <div className="space-y-4">
                    <div>
                      <div className="relative">
                        <input
                          type="text"
                          name="username"
                          placeholder="Username"
                          value={formData.username}
                          onChange={handleChange}
                          className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                            errors.username || !usernameValidation.isValid ? "border-destructive" : "border-border"
                          }`}
                        />
                        {isValidatingUsername && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-primary" />}
                        {!isValidatingUsername && usernameValidation.isValid && usernameValidation.message && (
                          <CheckCircle className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                        )}
                        {!isValidatingUsername && !usernameValidation.isValid && usernameValidation.message && (
                          <AlertCircle className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-destructive" />
                        )}
                      </div>
                      {errors.username && <p className="text-destructive text-sm mt-1">{errors.username}</p>}
                      {!errors.username && usernameValidation.message && (
                        <p className={`text-sm mt-1 ${usernameValidation.isValid ? "text-green-500" : "text-destructive"}`}>
                          {usernameValidation.message}
                        </p>
                      )}
                    </div>
                    <div>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          name="password"
                          placeholder="Password"
                          value={formData.password}
                          onChange={handleChange}
                          className={`w-full px-4 py-3 pr-12 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                            errors.password ? "border-destructive" : "border-border"
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-4 top-1/2 -translate-y-1/2 text-healthcare-text-muted hover:text-healthcare-text transition-colors"
                        >
                          {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                        </button>
                      </div>
                      {errors.password && <p className="text-destructive text-sm mt-1">{errors.password}</p>}
                      
                      {formData.password && (
                        <div className="mt-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                              <div
                                className={`h-full transition-all ${passwordStrength.color}`}
                                style={{ width: `${(passwordStrength.score + 1) * 25}%` }}
                              ></div>
                            </div>
                            <span className="text-xs font-medium">{passwordStrength.label}</span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className={formData.password.length >= 8 ? "text-green-600" : "text-muted-foreground"}>
                              ✓ At least 8 characters
                            </div>
                            <div className={/[a-z]/.test(formData.password) && /[A-Z]/.test(formData.password) ? "text-green-600" : "text-gray-500"}>
                              ✓ Uppercase & lowercase
                            </div>
                            <div className={/\d/.test(formData.password) ? "text-green-600" : "text-gray-500"}>
                              ✓ Numbers
                            </div>
                            <div className={/[^a-zA-Z\d]/.test(formData.password) ? "text-green-600" : "text-gray-500"}>
                              ✓ Special characters
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        type={showConfirmPassword ? "text" : "password"}
                        name="confirmPassword"
                        placeholder="Confirm Password"
                        value={formData.confirmPassword}
                        onChange={handleChange}
                        className={`w-full px-4 py-3 pr-12 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                          errors.confirmPassword ? "border-destructive" : "border-border"
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-healthcare-text-muted hover:text-healthcare-text transition-colors"
                      >
                        {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                      {errors.confirmPassword && <p className="text-destructive text-sm mt-1">{errors.confirmPassword}</p>}
                    </div>
                  </div>
                </div>

                {/* Business Details */}
                <div>
                  <h3 className="font-semibold text-xl text-healthcare-text mb-4">Business Details</h3>
                  <div>
                    <div className="relative">
                      <input
                        type="text"
                        name="abn"
                        placeholder="ABN Number"
                        value={formData.abn}
                        onChange={handleChange}
                        maxLength={14}
                        required
                        className={`w-full px-4 py-3 rounded-xl border bg-card text-healthcare-text placeholder:text-healthcare-text-muted focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all ${
                          errors.abn || (formData.abn && !abnValidation.isValid) ? "border-destructive" : "border-border"
                        }`}
                      />
                      {isValidatingABN && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-primary" />}
                      {!isValidatingABN && formData.abn && abnValidation.isValid && abnValidation.message && (
                        <CheckCircle className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                      )}
                      {!isValidatingABN && formData.abn && !abnValidation.isValid && abnValidation.message && (
                        <AlertCircle className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-destructive" />
                      )}
                    </div>
                    {errors.abn && <p className="text-destructive text-sm mt-1">{errors.abn}</p>}
                    {!errors.abn && formData.abn && abnValidation.message && (
                      <p className={`text-sm mt-1 ${abnValidation.isValid ? "text-green-500" : "text-destructive"}`}>
                        {abnValidation.message}
                      </p>
                    )}
                  </div>
                </div>

                <Button
                  type="submit"
                  variant="healthcare"
                  size="lg"
                  className="w-full"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Processing..." : "Continue to Payment"}
                </Button>
              </form>
            </div>

            {/* Summary Card */}
            <div className="bg-primary/5 p-8 flex items-start justify-center lg:sticky lg:top-0">
              <div className="bg-primary/10 rounded-2xl p-6 w-full max-w-[260px]">
                <h4 className="font-semibold text-xl text-healthcare-text text-center mb-4">
                  {billingPeriod === "yearly" ? "Yearly" : "Monthly"}
                </h4>
                <div className="text-center">
                  <span className="text-4xl font-bold text-primary">${billingPeriod === "yearly" ? plan.yearlyPrice : plan.monthlyPrice}</span>
                  <span className="text-healthcare-text-muted">{billingPeriod === "yearly" ? "/year" : "/month"}</span>
                </div>
                <p className="text-center text-sm text-healthcare-text-muted mt-3">
                  {plan.name}
                </p>
              </div>
            </div>
          </div>
        )}

        {step === "payment" && clientSecret && (
          <div className="p-8">
            <button 
              onClick={handleCancel}
              className="flex items-center gap-2 text-primary hover:text-primary/80 transition-colors mb-6 text-sm font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>

            <div className="max-w-2xl mx-auto">
              <Elements stripe={stripePromise} options={{ clientSecret }}>
                <StripePaymentForm
                  plan={plan}
                  billingPeriod={billingPeriod}
                  formData={formData}
                  paymentId={paymentId}
                  clientSecret={clientSecret}
                  subscriptionId={subscriptionId}
                  onSuccess={handlePaymentSuccess}
                  onError={handlePaymentError}
                  onCancel={handleCancel}
                  currentUser={currentUser}
                  authToken={token}
                  customerId={customerId}
                />
              </Elements>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PricingSignupForm;