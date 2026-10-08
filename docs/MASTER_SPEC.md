# RESTRO NEX

## Complete Master Project Specification

### Premium Multi-Tenant Restaurant POS & Management SaaS

---

# 01 — PROJECT STATUS

This is a completely NEW GREENFIELD PROJECT.

There is NO existing project.

There is NO existing codebase.

There is NO existing database.

There is NO existing authentication.

There is NO existing Supabase configuration.

There are NO previous phases.

Start everything from zero.

Do not assume any existing implementation.

---

# 02 — PRODUCT NAME

Product name:

# RestroNex

Tagline:

# One platform. Every restaurant.

RestroNex is a premium enterprise SaaS platform for restaurant businesses.

RestroNex is NOT a restaurant.

RestroNex is NOT a single restaurant billing application.

RestroNex is a software platform where many restaurants independently create accounts, subscribe to plans and operate their businesses.

Business model:

# Multi-Tenant Subscription SaaS

Example:

RestroNex
│
├── Restaurant A
│   ├── Outlet 1
│   ├── Outlet 2
│   └── Staff
│
├── Restaurant B
│   ├── Outlet 1
│   └── Staff
│
├── Restaurant C
│   ├── Outlet 1
│   ├── Outlet 2
│   ├── Outlet 3
│   └── Staff
│
└── Restaurant Chain
├── Outlet 1
├── Outlet 2
├── Outlet 3
└── Outlet N

All tenants use the same RestroNex platform while their data remains strictly isolated.

---

# 03 — TARGET MARKET

RestroNex must support different restaurant formats.

Target customers:

* Restaurants
* Cafés
* Bakeries
* Dessert shops
* Waffle shops
* QSRs
* Fast-food restaurants
* Fine-dining restaurants
* Juice shops
* Food courts
* Cloud kitchens
* Takeaway businesses
* Multi-brand restaurants
* Restaurant chains
* Enterprise restaurant groups

Do not design the system around one particular cuisine or restaurant.

The menu, POS, inventory and reporting architecture must be generic.

---

# 04 — PRODUCT VISION

Build RestroNex as a complete Restaurant Operating System.

Core areas:

1. POS & Billing
2. Order Management
3. Table Management
4. Kitchen Display System
5. Waiter/Captain Ordering
6. Menu Management
7. Recipe Management
8. Inventory
9. Purchasing
10. Customer CRM
11. Loyalty
12. Online Ordering
13. QR Ordering
14. Payment Management
15. Reports & Analytics
16. Staff Management
17. Multi-Outlet Management
18. Integrations
19. Subscription Management
20. RestroNex Super Admin
21. Audit & Security
22. Notifications

The final product should have the functional depth expected from a serious commercial restaurant POS SaaS.

---

# 05 — REFERENCE PRODUCT

Use Petpooja as a functional reference:

https://www.petpooja.com/poss

Study publicly available information about:

* Restaurant POS
* Billing
* Inventory
* Kitchen
* Reports
* Online ordering
* CRM
* Multi-outlet operations
* Restaurant management
* Integrations

Use the reference only to understand product requirements and common workflows.

DO NOT copy:

* Logo
* Brand identity
* Copyrighted artwork
* Proprietary code
* Exact marketing copy
* Private functionality
* Exact visual design

RestroNex must have its own identity and implementation.

---

# 06 — BRAND IDENTITY

Brand:

RestroNex

Positioning:

Premium enterprise restaurant technology platform.

Tagline:

One platform. Every restaurant.

Design direction:

# PREMIUM ENTERPRISE SAAS

Visual characteristics:

* Premium
* Clean
* Modern
* Professional
* Trustworthy
* Scalable
* Enterprise-ready
* Operationally efficient

Primary conceptual colours:

Deep green-black:
#101B19

Champagne gold:
#D4B477

Warm white:
#F5F3EE

Neutral grey/slate for operational interfaces.

Use gold as an accent, not as the dominant UI colour.

Do not make the POS look like a luxury marketing website.

Marketing pages can be premium and expressive.

POS/KDS must prioritise speed and clarity.

---

# 07 — TECHNOLOGY STACK

Use:

Frontend:

* Next.js
* React
* TypeScript
* Tailwind CSS

Backend:

* Next.js server-side architecture
* Server Actions and/or API routes where appropriate

Database:

* PostgreSQL

Recommended database platform:

* Supabase

Authentication:

Supabase Auth

Storage:

Supabase Storage

Security:

PostgreSQL Row Level Security

Deployment:

Vercel-compatible

Validation:

Zod or equivalent

Use strict TypeScript.

Use reusable components.

Use modular domain architecture.

Do not introduce unnecessary microservices.

---

# 08 — HIGH LEVEL ARCHITECTURE

Create:

RestroNex Public Website

RestroNex Authentication

RestroNex Restaurant Application

RestroNex POS

RestroNex KDS

RestroNex Waiter App

RestroNex Super Admin

RestroNex Subscription System

RestroNex Integration System

Use one unified design system.

Separate domain logic from UI.

Separate tenant data from platform data.

---

# 09 — MULTI-TENANT ARCHITECTURE

Every restaurant business is a tenant.

Example:

Tenant A

tenant_id = A

Tenant B

tenant_id = B

Tenant A must never access Tenant B.

Tenant isolation must exist at:

* Frontend
* Server
* Database

Use Row Level Security.

Every tenant-owned record must have a secure relationship to the correct business.

Never trust a client-supplied:

* tenant_id
* business_id
* outlet_id
* user role
* price
* tax
* discount
* payment status

Validate everything server-side.

---

# 10 — BUSINESS HIERARCHY

Use:

Platform
→ Business/Tenant
→ Outlet
→ Users/Staff
→ Restaurant Operations

A business can have:

1 outlet

or

100+ outlets.

Owner dashboard must support consolidated reporting.

Outlet users must only access authorised outlets.

---

# 11 — USER ROLES

Support:

* Super Admin
* Business Owner
* Business Admin
* Outlet Manager
* Cashier
* Waiter/Captain
* Kitchen Staff
* Inventory Manager
* Accountant

Use granular permissions.

Do not rely only on role names.

Permissions must be enforced server-side.

---

# 12 — AUTHENTICATION

Build:

* Sign up
* Login
* Logout
* Email verification
* Password recovery
* Session management
* Profile management

After signup:

Account
→ Business
→ Outlet
→ Configuration
→ Menu
→ Staff
→ Dashboard

Never grant Super Admin through public signup.

---

# 13 — RESTRO NEX PUBLIC WEBSITE

Create a premium SaaS marketing website.

Pages:

Home
Features
Solutions
POS
Inventory
Kitchen
Analytics
Multi-Outlet
Integrations
Pricing
About
Contact
Login
Sign Up

Hero:

# One platform. Every restaurant.

Supporting message:

Manage billing, orders, kitchen operations, inventory, customers and multiple outlets from one powerful restaurant platform.

Do not invent:

* Customer numbers
* Revenue claims
* Awards
* Certifications
* Partnerships
* Testimonials

unless they are actually provided.

---

# 14 — RESTAURANT ONBOARDING

Flow:

Sign Up
→ Verify Email
→ Create Business
→ Select Restaurant Type
→ Create Outlet
→ Configure Business
→ Configure Tax
→ Configure Tables
→ Configure Kitchen
→ Create Menu
→ Invite Staff
→ Select Subscription
→ Dashboard
→ POS

Make onboarding progressive and easy.

Show progress.

Allow incomplete onboarding to resume.

---

# 15 — OWNER DASHBOARD

Dashboard should include:

* Today's sales
* Orders
* Revenue
* Average order value
* Top products
* Category performance
* Payment breakdown
* Active kitchen orders
* Low stock
* Recent transactions
* Outlet performance

Filters:

* Today
* Yesterday
* This week
* This month
* Custom range
* Outlet

All statistics must eventually come from real database data.

Do not use fake financial numbers in production.

---

# 16 — POS

Create a fast restaurant POS.

Support:

* Product search
* Category navigation
* Product variants
* Modifiers
* Add-ons
* Combos
* Quantity
* Item notes
* Customer selection
* Table selection
* Dine-in
* Takeaway
* Delivery
* Hold order
* Resume order
* Cancel order
* Discount
* Coupons
* Taxes
* Service charge
* Packaging charge

Payments:

* Cash
* UPI
* Card
* Other configurable payment methods

Support:

* Split payment
* Partial payment
* Multiple payment methods
* Receipt
* Invoice
* KOT
* Reprint
* Refund

Use transactional processing.

Prevent duplicate checkout.

Use fixed precision or integer minor units for monetary calculations.

---

# 17 — TABLE MANAGEMENT

Create visual table management.

Support:

* Floor
* Sections
* Tables
* Capacity
* Available
* Occupied
* Reserved
* Billing

Actions:

* Create order
* Transfer table
* Merge table
* Split bill
* Request bill
* Complete bill

---

# 18 — KITCHEN DISPLAY SYSTEM

Create a dedicated KDS.

Features:

* Live order queue
* Kitchen stations
* Category routing
* Order timer
* Item timer
* Priority
* Preparation status
* Ready status
* Completion
* Cancelled item notification
* Sound notification
* Full-screen mode
* Touch support

Statuses:

NEW
→ ACCEPTED
→ PREPARING
→ READY
→ COMPLETED

---

# 19 — WAITER / CAPTAIN

Mobile/tablet ordering.

Waiter can:

* Login
* Select outlet
* Select table
* Add products
* Add modifiers
* Add notes
* Send order
* View order status
* Request bill

Do not give waiter financial administration permissions by default.

---

# 20 — UNIVERSAL MENU

Menu must support all restaurant types.

Categories:

* Categories
* Subcategories

Products:

* Name
* Description
* Image
* SKU
* Price
* Tax
* Category
* Availability

Advanced:

* Variants
* Modifiers
* Add-ons
* Combos
* Recipes
* Outlet pricing
* Outlet availability
* Scheduled availability

The menu is the single source of truth.

It feeds:

POS
KDS
Online Ordering
QR Ordering
Inventory
Reports

---

# 21 — RECIPE MANAGEMENT

Allow restaurant owners to define recipes.

Example:

Burger

Ingredients:
Bun × 1
Patty × 1
Cheese × 1
Sauce × 20g

When an order is completed:

Deduct the appropriate ingredients.

Prevent duplicate deductions.

Calculate:

Selling Price

* Ingredient Cost
  = Estimated Gross Margin

---

# 22 — INVENTORY

Create real inventory management.

Features:

* Ingredients
* Raw materials
* Units
* Unit conversions
* Stock levels
* Minimum stock
* Maximum stock
* Stock adjustments
* Stock transfers
* Wastage
* Batch
* Expiry
* Low stock alerts

Maintain an inventory movement ledger.

Do not simply overwrite stock quantities.

Every stock change must be traceable.

---

# 23 — PURCHASING

Create:

* Suppliers
* Purchase orders
* Purchase order items
* Goods receiving
* Purchase invoices
* Purchase history
* Supplier balances

Receiving stock creates inventory movements.

---

# 24 — CRM

Customer profiles:

* Name
* Phone
* Email
* Address
* Order history
* Total spend
* Last order
* Favourite products

Support segmentation.

---

# 25 — LOYALTY

Implement:

* Loyalty accounts
* Earn rules
* Redeem rules
* Points balance
* Loyalty transactions
* Rewards
* Coupons

Use a transaction ledger.

Prevent duplicate rewards.

---

# 26 — ONLINE ORDERING

Support architecture for:

* Restaurant website
* QR ordering
* Takeaway
* Delivery
* External aggregators

Create integration adapters for:

* Swiggy
* Zomato

If actual API access is unavailable:

Use clearly labelled:

DEMO / SANDBOX

Never fake a production integration.

---

# 27 — PAYMENTS

Create payment abstraction.

Support:

* Cash
* UPI
* Card
* Payment gateways

Prepare architecture for Razorpay or equivalent provider.

Payment provider webhooks must be verified.

Use idempotency.

Never trust frontend payment status.

---

# 28 — REPORTS

Create:

Sales reports

* Daily
* Weekly
* Monthly
* Outlet
* Product
* Category

Financial reports:

* Revenue
* Tax
* Discounts
* Refunds
* Payment reconciliation

Inventory:

* Stock
* Consumption
* Purchase
* Wastage
* Food cost

Staff:

* Cashier activity
* Discounts
* Refunds
* Orders

Customer:

* New customers
* Returning customers
* Spending
* Loyalty

Support:

* Date filtering
* Outlet filtering
* Search
* Pagination
* CSV
* Excel
* PDF where appropriate

---

# 29 — STAFF MANAGEMENT

Create staff management.

Owner can:

* Invite staff
* Assign roles
* Assign outlets
* Activate/deactivate staff
* Configure permissions

Sensitive operations must require appropriate permissions.

---

# 30 — AUDIT LOG

Track:

* Login events where appropriate
* Staff changes
* Permission changes
* Product changes
* Price changes
* Discounts
* Refunds
* Cancellations
* Inventory changes
* Subscription changes
* Settings changes

Record:

* Actor
* Tenant
* Outlet
* Action
* Target
* Timestamp
* Before/after values where appropriate

Never store passwords or secret keys in audit logs.

---

# 31 — SUPER ADMIN

Create separate RestroNex Super Admin.

Capabilities:

* Tenant management
* Business management
* Outlet management
* User management
* Subscription management
* Plan management
* Feature entitlements
* Platform usage
* Integration status
* Support
* Audit logs
* System health

Super Admin must be protected separately.

---

# 32 — SUBSCRIPTIONS

RestroNex is a paid SaaS.

Plans:

STARTER
GROWTH
SCALE
ENTERPRISE

Plan features should be configurable.

Potential limits:

* Outlets
* Staff
* POS terminals
* Reports
* Inventory
* CRM
* Online ordering
* Integrations
* Storage
* Analytics

Subscription states:

* Trial
* Active
* Past Due
* Cancelled
* Expired

Server-side entitlement enforcement is mandatory.

---

# 33 — NOTIFICATIONS

Support architecture for:

* Email
* SMS
* WhatsApp
* In-app notifications

Use only authorised APIs and configured providers.

---

# 34 — DATABASE SECURITY

Use:

* PostgreSQL
* Foreign keys
* Constraints
* Indexes
* RLS
* Secure migrations
* Server-side validation
* Tenant isolation

Never expose privileged database credentials.

Never disable RLS to solve application errors.

---

# 35 — OFFLINE POS

Evaluate offline POS carefully.

Where safe, support:

* Local draft
* Pending orders
* Sync queue
* Retry
* Conflict detection
* Idempotency
* Sync status

Statuses:

SYNCED
PENDING
FAILED

Never duplicate orders, payments or inventory movements.

---

# 36 — PERFORMANCE

Optimise:

* POS loading
* Product search
* Database queries
* Dashboard queries
* Images
* API requests
* Large reports

Use:

* Indexes
* Pagination
* Efficient queries
* Caching where appropriate

---

# 37 — ACCESSIBILITY

Support:

* Keyboard navigation
* Focus states
* Proper labels
* Accessible forms
* Good contrast
* Accessible dialogs
* Responsive layout

---

# 38 — TESTING

Test:

Authentication
Tenant isolation
RLS
Permissions
Menu
POS
Orders
Payments
Refunds
Inventory
Recipes
Purchasing
KDS
Reports
Subscriptions
Webhooks
Idempotency

Critical workflows require automated tests.

---

# 39 — DATABASE ENTITIES

Design a proper relational schema around:

Platform:

* subscription_plans
* plan_features
* feature_entitlements

Business:

* businesses
* business_settings
* outlets
* outlet_settings

Users:

* user_profiles
* memberships
* roles
* permissions
* role_permissions

Menu:

* menus
* categories
* products
* product_variants
* modifier_groups
* modifiers
* product_modifiers
* combos
* combo_items

Recipes:

* ingredients
* units
* recipes
* recipe_ingredients

Restaurant:

* dining_sections
* dining_tables
* kitchen_stations

Orders:

* orders
* order_items
* order_item_modifiers
* order_status_history

Payments:

* payments
* refunds
* invoices
* payment_methods

Cash:

* cash_sessions
* cash_movements

Inventory:

* inventory_items
* inventory_movements
* stock_adjustments
* stock_transfers
* stock_transfer_items

Purchasing:

* suppliers
* purchase_orders
* purchase_order_items
* goods_receipts
* purchase_invoices

Customers:

* customers
* customer_addresses
* loyalty_accounts
* loyalty_transactions
* coupons
* customer_feedback

Integrations:

* integration_accounts
* webhook_events
* integration_logs

SaaS:

* subscriptions
* subscription_events
* billing_records

Security:

* audit_logs

Do not blindly create unnecessary tables. Normalise according to actual requirements.

---

# 40 — UI DESIGN SYSTEM

Create reusable:

* Buttons
* Inputs
* Selects
* Tables
* Cards
* Dialogs
* Dropdowns
* Tabs
* Badges
* Charts
* Navigation
* Sidebars
* Toasts
* Empty states
* Loading states

Use one consistent RestroNex design system.

---

# 41 — CRITICAL UX RULE

POS:

Speed > decoration.

KDS:

Visibility > decoration.

Dashboard:

Information hierarchy > decoration.

Marketing:

Brand experience > operational density.

Do not add unnecessary animation.

Do not use excessive glassmorphism.

Do not make every card huge.

Do not make the interface difficult for restaurant employees.

---

# 42 — PRODUCTION QUALITY

A feature is NOT complete if:

* Only the UI exists
* Buttons do nothing
* Data is hardcoded
* Database isn't connected
* Permissions are frontend-only
* Payment is fake
* Integration is fake
* Reports are fake
* Security is missing

Every important feature must work end-to-end.

---

# 43 — GREENFIELD DEVELOPMENT PHASES

Build in this order:

PHASE 0
Project Foundation

PHASE 1
Supabase + Database Foundation

PHASE 2
Multi-Tenant Architecture + RLS

PHASE 3
Authentication

PHASE 4
Business + Outlet Management

PHASE 5
Roles + Permissions

PHASE 6
Restaurant Onboarding

PHASE 7
Universal Menu Management

PHASE 8
POS + Order Management

PHASE 9
Tables + Dine-In Operations

PHASE 10
Payments + Billing + Receipts

PHASE 11
KOT + Kitchen Display System

PHASE 12
Waiter/Captain Ordering

PHASE 13
Recipes + Inventory

PHASE 14
Purchasing + Suppliers

PHASE 15
CRM + Loyalty

PHASE 16
Reports + Analytics

PHASE 17
Online Ordering + QR Ordering

PHASE 18
Integrations

PHASE 19
Super Admin

PHASE 20
Subscriptions + SaaS Billing

PHASE 21
Notifications

PHASE 22
Offline POS + Sync

PHASE 23
Security Hardening

PHASE 24
Performance Optimisation

PHASE 25
Production Testing + Deployment

---

# 44 — EXECUTION RULE

DO NOT BUILD ALL PHASES AT ONCE.

I will provide the phase prompts one at a time.

When receiving a phase prompt:

1. Inspect the current project.
2. Implement only the requested phase.
3. Do not unnecessarily modify future modules.
4. Create required database migrations.
5. Implement backend logic.
6. Implement frontend.
7. Connect real data.
8. Implement security.
9. Add tests.
10. Run lint.
11. Run TypeScript checks.
12. Fix errors.
13. Verify the complete workflow.
14. Report exactly what was completed.
15. Report anything that remains.

Never claim completion without verification.

---

# 45 — LEGAL / BRAND CHECK

Before public commercial launch:

Check:

* RestroNex trademark availability
* Company/business name availability
* Domain availability
* Social media handles
* Similar software/technology brands

Do not claim trademark ownership until verified.

Do not claim a domain is available until checked.

RestroNex is the selected working brand.

---

# 46 — FINAL PRODUCT

The final architecture should be:

RESTRO NEX
│
├── Marketing Website
├── Authentication
├── Super Admin
│
└── Multi-Tenant SaaS
│
├── Business
│   ├── Outlet
│   ├── POS
│   ├── KDS
│   ├── Menu
│   ├── Inventory
│   ├── Purchasing
│   ├── CRM
│   ├── Reports
│   └── Staff
│
├── Business
│   └── Multiple Outlets
│
└── Restaurant Chains

The platform must be scalable from one small restaurant to large multi-outlet restaurant groups.

START FROM ZERO.

Do not create a fake prototype.

Build RestroNex as a real commercial SaaS architecture.
