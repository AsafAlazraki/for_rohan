## Summary
| Marketo-CRM Integration Field Mapping Specification | Unnamed: 1 | Unnamed: 2 |
| --- | --- | --- |
| NaN | NaN | NaN |
| Document Overview | NaN | NaN |
| This workbook defines the field mappings between Marketo marketing automation platform and Dynamics 365 CRM. | NaN | NaN |
| It specifies how data fields should be synchronized between the two systems for Companies, Contacts, and Leads. | NaN | NaN |
| NaN | NaN | NaN |
| Sheet Overview | NaN | NaN |
| Sheet Name | Purpose | Key Content |
| Summary | Document overview and navigation | This summary page with sheet descriptions |
| Company | Company/Account field mappings | Maps Marketo Company fields to Dynamics 365 Account table fields |
| Contact | Contact field mappings | Maps Marketo Person fields to Dynamics 365 Contact table fields |
| Leads | Lead field mappings | Maps Marketo Person fields to Dynamics 365 Lead table fields |
| Relationships | CRM relationship definitions | Defines how records relate to each other in CRM (record1id, record2id, roles) |
| Industry Classification | Industry classification reference | Contains sample SQL for industry classification lookups |
| NaN | NaN | NaN |
| Field Mapping Structure | NaN | NaN |
| Each mapping sheet contains the following columns: | NaN | NaN |
| • Marketo Field - The field name in Marketo | NaN | NaN |
| • Table Name / Schema - Marketo table details | NaN | NaN |
| • Field Type - Data type and character limits | NaN | NaN |
| • Dynamics 365 Table - Target CRM table (account, contact, lead) | NaN | NaN |
| • Logical Name / Schema Name - CRM field identifiers | NaN | NaN |
| • Display Name - User-friendly field name in CRM | NaN | NaN |
| • Attribute Type - Data type (Text, Choice, Lookup, Boolean, GUID) | NaN | NaN |
| • Notes - Additional implementation notes | NaN | NaN |
| • Options - Available values for Choice/Boolean fields | NaN | NaN |
| NaN | NaN | NaN |
| Reference: See linked document for Integration Behaviour & Rules Specification | NaN | NaN |
| Marketo-CRM Integration Behaviour & Rules Specification.docx | NaN | NaN |

## Company
| Marketo (Company) | Unnamed: 1 | Unnamed: 2 | Unnamed: 3 | Dynamics365 | Unnamed: 5 | Unnamed: 6 | Unnamed: 7 | Unnamed: 8 | Unnamed: 9 | Unnamed: 10 | Unnamed: 11 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Marketo Field | Table Name | Schema | Field Type (Characters) | Table | Logical Name | Schema Name | Display Name | Attribute Type | Notes | Options | Mapping to Existing Data (Rocky) |
| Account Number | NaN | NaN | NaN | account | accountnumber | AccountNumber | Account Number | Text | NaN | NaN | NaN |
| Company Name | NaN | NaN | NaN | account | name | Name | Account Name | Text | NaN | NaN | NaN |
| Industry Sector / Category | NaN | NaN | NaN | ubt\_industryclassification> | NaN | NaN | NaN | NaN | NaN | ubt\_Account\_Accountid\_ubt\_IndustryClassification.name | NaN |
| E Profile | NaN | NaN | NaN | account | ubt\_eprofile | ubt\_Eprofile | eProfile | Choice | NaN | NaN | NaN |
| Sales Account Manager | NaN | NaN | NaN | account | ubt\_KeyAccountManager | ubt\_keyaccountmanager | Key Account Manager | Lookup | NaN | NaN | NaN |
| Market Position/Business Type (UK only at present I believe) | NaN | NaN | NaN | account | ubt\_accounttype | ubt\_accounttype | Account Type | Choice | NaN | Options:\_x000D\_\n1: Competitor (no color)\_x000D\_\n2: Consultant (no color)\_x000D\_\n3: Customer (no color)\_x000D\_\n4: Investor (no color)\_x000D\_\n5: Partner (no color)\_x000D\_\n6: Influencer (no color)\_x000D\_\n7: Press (no color)\_x000D\_\n8: Prospect (no color)\_x000D\_\n9: Reseller (no color)\_x000D\_\n10: Supplier (no color)\_x000D\_\n11: Vendor (no color)\_x000D\_\n12: Other (no color)\_x000D\_\nDefault: N/A | NaN |
| B2B | NaN | NaN | NaN | account | ubt\_markettype | ubt\_markettype | Market Type | Choice | NaN | Options:\_x000D\_\n900000000: Business to Individual Customers (B2C) (no color)\_x000D\_\n900000001: Business to Business (B2B) (no color)\_x000D\_\n900000002: Sole Trader (C2B) (no color)\_x000D\_\n900000003: Online Marketplace/Retailer (C2C) (no color)\_x000D\_\nDefault: N/A | UK.Accounts.Market Position |
| B2C | NaN | NaN | NaN | account | ubt\_markettype | ubt\_markettype | Market Type | Choice | NaN | NaN | UK.Accounts.Market Position |
| Sole Trader | NaN | NaN | NaN | account | ubt\_markettype | ubt\_markettype | Market Type | Choice | NaN | NaN | UK.Accounts.Market Position |
| Business Model (recently added by Sales) | NaN | NaN | NaN | account | ubt\_markettype | ubt\_markettype | Market Type | Choice | NaN | NaN | UK.Accounts.Market Position |
| Manufacturing/Production | NaN | NaN | NaN | account | ubt\_tradingmodel | ubt\_TradingModel | Trading Model | Choice | NaN | Options:\_x000D\_\n900000000: Business to Individual Customers (B2C) (no color)\_x000D\_\n900000001: Business to Business (B2B) (no color)\_x000D\_\n900000002: Sole Trader (C2B) (no color)\_x000D\_\n900000003: Online Marketplace/Retailer (C2C) (no color)\_x000D\_\nDefault: N/A | UK.Accounts.Business Model |
| Projects/Contracting | NaN | NaN | NaN | account | ubt\_tradingmodel | ubt\_TradingModel | Trading Model | Choice | NaN | NaN | UK.Accounts.Business Model |
| Wholesale | NaN | NaN | NaN | account | ubt\_tradingmodel | ubt\_TradingModel | Trading Model | Choice | NaN | NaN | UK.Accounts.Business Model |
| Real Estate/Holdings | NaN | NaN | NaN | account | ubt\_tradingmodel | ubt\_TradingModel | Trading Model | Choice | NaN | NaN | UK.Accounts.Business Model |
| Service | NaN | NaN | NaN | account | ubt\_tradingmodel | ubt\_TradingModel | Trading Model | Choice | NaN | NaN | UK.Accounts.Business Model |
| Distribution/Resale | NaN | NaN | NaN | account | ubt\_tradingmodel | ubt\_TradingModel | Trading Model | Choice | NaN | NaN | UK.Accounts.Business Model |
| NaN | NaN | NaN | NaN | account | accountid | accountid | Account | GUID | CRM Primary Key | NaN | NaN |

## Contact
| Unnamed: 0 | Unnamed: 1 | Unnamed: 2 | Unnamed: 3 | Unnamed: 4 | Unnamed: 5 | Unnamed: 6 | Unnamed: 7 | Unnamed: 8 | Unnamed: 9 | Unnamed: 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Marketo (Person) | NaN | NaN | NaN | Dynamics365 | NaN | NaN | NaN | NaN | NaN | NaN |
| Marketo Field | Table Name | Schema | Field Type (characters) | Table | Logical Name | Schema Name | Display Name | Attribute Type | Notes | Options |
| Title | NaN | NaN | NaN | contact | jobtitle | JobTitle | Job Title | Text | NaN | NaN |
| First Name | NaN | NaN | NaN | contact | firstname | FirstName | First Name | Text | NaN | NaN |
| Last Name | NaN | NaN | NaN | contact | lastname | LastName | Last Name | Text | NaN | NaN |
| Email Address | NaN | NaN | NaN | contact | emailaddress1 | EMailAddress1 | Email | Text | NaN | NaN |
| Account Type (Business, Household, Advisor, Supplier) | NaN | NaN | NaN | contact | NaN | NaN | NaN | Choice | contact.parentcustomerid.ubt\_accounttype | Options:\_x000D\_\n1: Competitor (no color)\_x000D\_\n2: Consultant (no color)\_x000D\_\n3: Customer (no color)\_x000D\_\n4: Investor (no color)\_x000D\_\n5: Partner (no color)\_x000D\_\n6: Influencer (no color)\_x000D\_\n7: Press (no color)\_x000D\_\n8: Prospect (no color)\_x000D\_\n9: Reseller (no color)\_x000D\_\n10: Supplier (no color)\_x000D\_\n11: Vendor (no color)\_x000D\_\n12: Other (no color)\_x000D\_\nDefault: N/A |
| Address – Street | NaN | NaN | NaN | contact | address1\_line1 | Address1\_Line1 | Address 1: Street 1 | Text | NaN | NaN |
| Address – Town/City | NaN | NaN | NaN | contact | address1\_city | Address1\_City | Address 1: City | Text | NaN | NaN |
| Address - Country | NaN | NaN | NaN | contact | ubt\_address1\_country | ubt\_address1\_country | Country/Region | Lookup | NaN | NaN |
| Address – Postal Code | NaN | NaN | NaN | contact | address1\_postalcode | Address1\_PostalCode | Address 1: ZIP/Postal Code | Text | NaN | NaN |
| KAM Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Primary Contact (Yes/No) | NaN | NaN | NaN | contact | NaN | NaN | NaN | NaN | contact.contactid == contact.parentcustomerid.primarycontactid | NaN |
| Phone | NaN | NaN | NaN | contact | telephone1 | Telephone1 | Business Phone | Text | NaN | NaN |
| Mobile Phone | NaN | NaN | NaN | contact | mobilephone | MobilePhone | Mobile Phone | Text | NaN | NaN |
| Job Title | NaN | NaN | NaN | contact | jobtitle | JobTitle | Job Title | Text | NaN | NaN |
| Community Status (Yes/No) | NaN | NaN | NaN | NaN | ubt\_communitymember | ubt\_communitymember | Community Member | Choice | NaN | Options:\_x000D\_\n900000000: Yes (no color)\_x000D\_\n900000001: No (no color)\_x000D\_\n900000002: Unsure (no color)\_x000D\_\nDefault: N/A |
| Technology Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| People/HR Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Procurement Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Logistics Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Finance Contact(Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Seniority | NaN | NaN | NaN | NaN | jobtitle | JobTitle | Job Title | NaN | single value | NaN |
| ???????????????? | NaN | NaN | NaN | contact | donotbulkemail | donotbulkemail | Bulk Email | Boolean | NaN | True: Do Not Allow\_x000D\_\nFalse: Allow\_x000D\_\nDefault Value: True |
| NaN | NaN | NaN | NaN | contact | contactid | contactid | Contact | NaN | CRM Primary Key | NaN |
| NaN | NaN | NaN | NaN | contact | ubt\_marketoid | NaN | NaN | NaN | Marketo Primary key (Blank in Goldvision) | NaN |

## Leads
| Unnamed: 0 | Unnamed: 1 | Unnamed: 2 | Unnamed: 3 | Unnamed: 4 | Unnamed: 5 | Unnamed: 6 | Unnamed: 7 | Unnamed: 8 | Unnamed: 9 | Unnamed: 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Marketo (Person) | NaN | NaN | NaN | Dynamics365 | NaN | NaN | NaN | NaN | NaN | NaN |
| Marketo Field | Table Name | Schema | Field Type (characters) | Table | Logical Name | Schema Name | Display Name | Attribute Type | Notes | Options |
| Title | NaN | NaN | NaN | lead | jobtitle | JobTitle | Job Title | Text | NaN | NaN |
| First Name | NaN | NaN | NaN | lead | firstname | FirstName | First Name | Text | NaN | NaN |
| Last Name | NaN | NaN | NaN | lead | lastname | LastName | Last Name | Text | NaN | NaN |
| Email Address | NaN | NaN | NaN | lead | emailaddress1 | EMailAddress1 | Email | Text | NaN | NaN |
| Account Type (Business, Household, Advisor, Supplier) | NaN | NaN | NaN | <account> | NaN | NaN | NaN | Choice | contact.parentcustomerid.ubt\_accounttype | Options:\_x000D\_\n1: Competitor (no color)\_x000D\_\n2: Consultant (no color)\_x000D\_\n3: Customer (no color)\_x000D\_\n4: Investor (no color)\_x000D\_\n5: Partner (no color)\_x000D\_\n6: Influencer (no color)\_x000D\_\n7: Press (no color)\_x000D\_\n8: Prospect (no color)\_x000D\_\n9: Reseller (no color)\_x000D\_\n10: Supplier (no color)\_x000D\_\n11: Vendor (no color)\_x000D\_\n12: Other (no color)\_x000D\_\nDefault: N/A |
| Address – Street | NaN | NaN | NaN | lead | address1\_line1 | Address1\_Line1 | Address 1: Street 1 | Text | NaN | NaN |
| Address – Town/City | NaN | NaN | NaN | lead | address1\_city | Address1\_City | Address 1: City | Text | NaN | NaN |
| Address - Country | NaN | NaN | NaN | lead | ubt\_countryid | ubt\_Countryid | Country | Lookup | ubt\_country.countryid | NaN |
| Address – Postal Code | NaN | NaN | NaN | lead | address1\_postalcode | Address1\_PostalCode | Address 1: ZIP/Postal Code | Text | NaN | NaN |
| KAM Contact (Yes/No) | NaN | NaN | NaN | <parent account> | NaN | NaN | NaN | NaN | NaN | NaN |
| Primary Contact (Yes/No) | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | contact.contactid == contact.parentcustomerid.primarycontactid | NaN |
| Phone | NaN | NaN | NaN | lead | telephone1 | Telephone1 | Business Phone | Text | NaN | NaN |
| Mobile Phone | NaN | NaN | NaN | lead | mobilephone | MobilePhone | Mobile Phone | Text | NaN | NaN |
| Job Title | NaN | NaN | NaN | lead | jobtitle | JobTitle | Job Title | Text | NaN | NaN |
| Community Status (Yes/No) | NaN | NaN | NaN | NaN | ubt\_communitymember | ubt\_communitymember | Community Member | Choice | NaN | Options:\_x000D\_\n900000000: Yes (no color)\_x000D\_\n900000001: No (no color)\_x000D\_\n900000002: Unsure (no color)\_x000D\_\nDefault: N/A |
| Technology Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| People/HR Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Procurement Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Logistics Contact (Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Finance Contact(Yes/No) | NaN | NaN | NaN | <Relationships> | NaN | NaN | NaN | NaN | NaN | NaN |
| Seniority | NaN | NaN | NaN | lead | jobtitle | JobTitle | Job Title | NaN | single value | NaN |
| NaN | NaN | NaN | NaN | lead | contactid | contactid | Contact | GUID | CRM Primary Key | NaN |
| NaN | NaN | NaN | NaN | lead | accountid | NaN | NaN | GUID | Marketo Primary key (Blank in Goldvision) | NaN |
| NaN | NaN | NaN | NaN | NaN | subject | Subject | Topic | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | description | Description | Description | Text | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | ownerid | OwnerId | Owner | GUID | NaN | NaN |
| NaN | NaN | NaN | NaN | lead | leadsourcecode | NaN | Lead Source | Choice | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | owningbusinessunitid | NaN | NaN | Lookup | NaN | NaN |

## Relationships
| CRM Relationships | Unnamed: 1 | Unnamed: 2 | Unnamed: 3 | Unnamed: 4 | Unnamed: 5 | Unnamed: 6 | Unnamed: 7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NaN | NaN | NaN | NaN | NaN | NaN | SQL Sample (Accounts) | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| Mapping Table | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | CRM Concept | Table | Column | NaN | NaN | NaN | NaN |
| NaN | Relationship | relationship | record1id, record2id | NaN | NaN | NaN | NaN |
| NaN | Relationship Role (side 1) | relationship → relationshiprole | record1roleid.name | NaN | NaN | NaN | NaN |
| NaN | Relationship Role (side 2) | relationship → relationshiprole | record2roleid.name | NaN | NaN | Web API Example (Accountrs) | NaN |
| NaN | Role check | Logic | Match role name on the Account’s side | NaN | NaN | NaN | Step 1 - Filter Relationships for an Account |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | Step 2 - Evaluate Results | NaN |

## Industry Classification
| Unnamed: 0 | Unnamed: 1 | Unnamed: 2 | Unnamed: 3 | Unnamed: 4 | Unnamed: 5 | Unnamed: 6 | Unnamed: 7 | Unnamed: 8 | Unnamed: 9 | Unnamed: 10 | Unnamed: 11 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN |
| NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | NaN | sample SQL |