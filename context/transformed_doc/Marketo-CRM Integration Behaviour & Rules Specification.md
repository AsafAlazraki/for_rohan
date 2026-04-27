# **Marketo ↔ Dynamics 365 CRM**

**Integration Behaviour & Rules Specification**

This document defines the **integration scope**, **system-of-record boundaries**, **matching rules**, and **triggered behaviours** for data flow between Marketo and Dynamics 365 CRM.

**Guiding principles:** CRM is authoritative for identity and relationships; Marketo is authoritative for marketing consent and engagement; any Marketo → CRM write-back is explicitly scoped and documented below.

## **Background & Governance**

### **System of Record & Authority**

|  |  |
| --- | --- |
| **Domain** | **Authoritative System** |
| Account identity | CRM |
| Person identity (Lead vs Contact) | CRM |
| Account–Person relationships | CRM |
| Marketing consent & unsubscribe | Marketo |
| Marketing engagement data | Marketo |

**Controlled Exception**

Marketo is authorised to update a limited set of **CRM Contact consent fields** to reflect global unsubscribe events originating in Marketo.

This exception **does not extend to identity, lifecycle, or qualification data**.

### **Integration Scope**

|  |  |  |
| --- | --- | --- |
| **CRM Entity** | **Marketo Entity** | **Direction** |
| Account | Company | CRM → Marketo (New & Updated Accounts) |
| Contact | Lead (Person) | CRM → Marketo (New & Updated Contacts) |
| Contact | Lead (Person) | **Marketo → CRM (Global Unsubscribes only)** |
| Lead | Lead (Person) | Marketo → CRM (\*New Leads)  (see section on *Lead vs Contact Determination in Marketo*) |
| Lead | Lead (Person) | CRM → Marketo (Qualification / Disqualification) |

### **CRM → Marketo Sync Trigger Conditions**

**Decision required:** confirm the inclusion gates for Account and Contact (e.g., status values, required fields, and any “Sync to Marketo” flag).

|  |  |  |
| --- | --- | --- |
| **Entity** | **When to sync (trigger)** | **Gate / exclusions** |
| Account | On **Create**, and on **Update** when a field mapped to Marketo changes. |  |
| Contact | On **Create**, and on **Update** when a field mapped to Marketo changes. |  |

Note: Only changes to fields included in the agreed **CRM → Marketo field mapping** should trigger a sync.

## **Matching & Data Model**

### **Account → Company Matching Rules**

*CRM Account ID primary*

*Fallbacks: Company Number, NetSuite ID , Other?*

### **Person (Lead / Contact) Matching & Update Rules**

### **Primary Matching Key**

- CRM: Contact ID
- CRM: emailaddress1
- Marketo: email

### **Marketo → CRM Behaviour (Explicit Exception)**

Marketo is permitted to initiate updates to **CRM Contact records only** when required to enforce **global unsubscribe**.

**Scope of Update (Strictly Limited)**

|  |  |
| --- | --- |
| **CRM Field** | **Purpose** |
| donotbulkemail | Global marketing unsubscribe |

No other Contact fields may be updated by Marketo.

**Trigger condition:** When a **Marketo Person** is marked as **globally unsubscribed**, and that Person has a populated **crmContactId** (i.e., is linked to an existing **CRM Contact**).

**Resilience requirement:** The integration must **validate the CRM Contact ID still exists** (e.g., contact not deleted/merged/inactive) before applying the unsubscribe update. If the Contact ID is missing or stale, the integration should attempt to **re-resolve the Contact** (e.g., by email match) and otherwise skip the update and log the outcome.

**Matching Logic**

#### 1. Match Marketo Person to CRM record using crmContactId (Contact ID)
#### 2. Verify the CRM Contact exists and is eligible for update (e.g., not deleted/merged/inactive)
#### 3. Confirm the resolved record represents a CRM Contact
#### 4. Update consent fields only

If a matching CRM Contact cannot be resolved:

- The update is skipped

### **Lead vs Contact Determination in Marketo**

Marketo represents both Leads and Contacts as a single Person object.

|  |  |
| --- | --- |
| **Indicator** | **Interpretation** |
| crmContactId populated | Contact |
| crmLeadId populated | Lead |
| isCustomer = true | Contact |
| isLead = true | Lead |

### **Person → Company Association**

Persons are linked to Companies via the persisted **CRM Account ID**.

## **Operational Behaviour**

|  |  |  |
| --- | --- | --- |
| **Event** | **Target** | **Behaviour** |
| New Lead creation | CRM Lead | Create |
| Global Unsubscribe | CRM Contact | Update donotbulkemail = true |

Note: Marketo → CRM Lead creation is governed by the **Sync Eligibility Criteria** defined **in this section**; records that do not meet criteria must not create CRM Leads.

\*Marketo **does not**:

- Create or update CRM Accounts
- Update CRM Leads for consent
- Create Contact Records directly (only indirectly where a lead cannot find a contact to match)
- Update non-consent Contact fields

### **Marketo Lead → CRM Sync Eligibility Criteria (TBD)**

The criteria below define which **Marketo Person records** (treated as Leads) are permitted to create a **CRM Lead**. This is **to be decided**.

|  |  |  |
| --- | --- | --- |
| **Decision required** (populate before go-live): rule owner, effective date, environment scope, and criteria version/change control.  **Criterion** | **Rule (TBD)** | **Rationale / Notes** |
| Person type | *[e.g., isLead = true AND crmLeadId is blank AND crmContactId is blank]* | Prevents creating duplicates for existing CRM Leads |
| Company exists in CRM |  | The Account record must be present as all leads must be linked to a CRM Account. |
| Email present & valid | *[required / optional]* | Email is the primary matching key in this integration. |
| Consent / marketing eligibility | *[e.g., not globally unsubscribed]* | Aligns with the consent authority model (Marketo as source for unsubscribe). |
| Lifecycle / qualification gate |  | Controls CRM volume and ensures Sales only sees sales-ready leads (if desired). |
| Country/region scope |  | Optional governance if CRM is region-partitioned or teams are segmented. |
| Data completeness minimum | *[e.g., first name + last name + email + company]* | Improves Sales usability and reduces rework. |
| Additional Exclusion Criteria |  | Prevents undesirable lead creation and helps compliance/reporting. |
| Source channel scope |  | Optional control if some acquisition sources should remain marketing-only. |
| Other Criteria |  |  |

**If criteria are not met**: CRM Lead creation is skipped, and the integration records an outcome (ineligible + reason) for operational monitoring and troubleshooting.