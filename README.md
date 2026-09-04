# Pramogh Gemstone Integration — Final Flow

## Customer flow
1. Customer fills the gemstone recommendation form.
2. **Continue to Consultation** calls `/api/gemstone/lead`. This creates/updates the Freshsales contact using `mobile_number` and creates the Freshsales Note. No WATI message is sent here.
3. Customer selects one consultation package.
4. **Pay Securely** creates a Razorpay order and opens Razorpay Checkout.
5. After Razorpay returns a successful payment, `/api/gemstone/verify-payment` verifies the signature server-side.
6. Only after verified payment, the Freshsales Note is updated with consultation/payment details and the WATI `Gems recomendation` template is sent to the configured business number.
7. The page also prepares a WhatsApp confirmation link containing the payment ID and customer details.

## Security
Keep all Freshsales, WATI, and Razorpay secrets in Vercel Environment Variables. Shopify only receives the backend URL and public Razorpay Key ID.

## Environment variables
- FRESHSALES_BUNDLE_ALIAS
- FRESHSALES_API_KEY
- WATI_ENDPOINT
- WATI_TOKEN
- WATI_TEMPLATE_NAME
- WATI_OWNER_NUMBER
- WATI_CHANNEL_NUMBER (optional)
- RAZORPAY_KEY_ID
- RAZORPAY_KEY_SECRET


### Freshsales status
On every successful form submission, the backend resolves the Freshsales contact status named **New**
using `/api/selector/contact_statuses` and sends its ID as `contact_status_id` for the matched/created contact.
This avoids hard-coding an account-specific status ID.


### Current Recent Source
Freshsales custom field:
- Label: Recent Source
- Internal name: `cf_sub_source`
- Value sent by this backend: `Gems recomendation`

### Current WATI template
The backend sends the customer WhatsApp message using:
- Template: `Gems recomendation`
- Destination: the customer's submitted WhatsApp number
- Trigger: only after successful Razorpay signature verification
