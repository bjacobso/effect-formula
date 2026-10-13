// Production expressions sampled through Metabase database 2 on 2026-10-13.
// The 90-day corpus excludes test/demo accounts and deleted tasks/accounts/orgs.
// Selected common patterns plus examples of every observed function; all inputs
// below are synthetic. Expressions retain their original names and literals.
// These are engine contracts, not tax or document-validation rules.

export type FormulaResult = string | number | boolean | null | { readonly error: string };

export type FormulaCase = {
  readonly label: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly expected: FormulaResult;
  readonly serverExpected?: FormulaResult;
};

export type FormulaFixture = {
  readonly label: string;
  readonly formula: string;
  readonly cases: readonly FormulaCase[];
};

// The three score expressions and their SUM come from the same production
// quiz. This also exercises multi-select serialization and formula dependencies.
export const PRODUCTION_QUIZ_FIXTURE: {
  readonly formulas: Readonly<Record<string, string>>;
  readonly totalFormula: string;
  readonly cases: readonly FormulaCase[];
} = {
  formulas: {
    "form.formula_q1_score":
      '=IF(ISERROR(FIND("show_the_customer_the_ingredient_list_on_the_product_label",TRIM(form.radio_q1))),0,1)',
    "form.formula_q2_score":
      '=IF(ISERROR(FIND("don_t_feed_them",TRIM(form.multi_select_q2))), 0,1) + IF(ISERROR(FIND("don_t_let_them_in",TRIM(form.multi_select_q2))), 0,1) + IF(ISERROR(FIND("report_it",TRIM(form.multi_select_q2))), 0,1)',
    "form.formula_q3_score":
      '=IF(ISERROR(FIND("ensuring_the_structure_of_the_building_is_intact_and_there_are_no_gaps_around_doors_and_pipe-work_or_holes_in_drains_and_walls",TRIM(form.multi_select_q3))), 0,1) + IF(ISERROR(FIND("checking_that_packaging_is_intact_when_the_products_are_delivered",TRIM(form.multi_select_q3))), 0,1) + IF(ISERROR(FIND("operating_a_closed-door_policy",TRIM(form.multi_select_q3))), 0,1)',
  },
  totalFormula: "=SUM(form.formula_q1_score,form.formula_q2_score,form.formula_q3_score)",
  cases: [
    {
      label: "unanswered quiz",
      data: {},
      expected: 0,
    },
    {
      label: "all correct choices",
      data: {
        "form.radio_q1": "show_the_customer_the_ingredient_list_on_the_product_label",
        "form.multi_select_q2": ["don_t_feed_them", "don_t_let_them_in", "report_it"],
        "form.multi_select_q3": [
          "ensuring_the_structure_of_the_building_is_intact_and_there_are_no_gaps_around_doors_and_pipe-work_or_holes_in_drains_and_walls",
          "checking_that_packaging_is_intact_when_the_products_are_delivered",
          "operating_a_closed-door_policy",
        ],
      },
      expected: 7,
    },
    {
      label: "partial credit and irrelevant choices",
      data: {
        "form.radio_q1": "wrong",
        "form.multi_select_q2": ["report_it", "wrong", "don_t_feed_them"],
        "form.multi_select_q3": ["operating_a_closed-door_policy"],
      },
      expected: 3,
    },
    {
      label: "duplicate selections count a choice once",
      data: {
        "form.multi_select_q2": ["report_it", "report_it"],
      },
      expected: 1,
    },
  ],
};

// Bare null is a named expression in HyperFormula. The browser binds every
// referenced name (including null) through convertValue; the server binds form
// fields only. serverExpected records the observed difference explicitly.
export const PRODUCTION_FORMULA_FIXTURES: readonly FormulaFixture[] = [
  {
    label: "I-9 conditional document-number copy",
    formula:
      '=IF(AND(form.employee_document_types="list_b_and_c", form.listb_document_type="state_dl_id"), form.listb_state_doc_number, "")',
    cases: [
      {
        label: "keeps leading zeros",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_number": "001234567",
        },
        expected: "001234567",
      },
      {
        label: "keeps long identifiers",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_number": "12345678901234567890",
        },
        expected: "12345678901234567890",
      },
      {
        label: "keeps existing numeric coercion",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_number": "7956297",
        },
        expected: 7956297,
      },
      {
        label: "requires both selections",
        data: {
          "form.employee_document_types": "list_a",
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_number": "001234567",
        },
        expected: "",
      },
      {
        label: "rejects another document type",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "school_id",
        },
        expected: "",
      },
      {
        label: "copies a blank value",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
        },
        expected: null,
      },
    ],
  },
  {
    label: "I-9 AND with an OR condition",
    formula:
      '=IF(AND(OR(form.citizenship_status_code="us_citizen", form.citizenship_status_code="noncitizen"), form.employee_document_types="list_a"), form.us_passport_number, "")',
    cases: [
      {
        label: "first accepted citizenship",
        data: {
          "form.citizenship_status_code": "us_citizen",
          "form.employee_document_types": "list_a",
          "form.us_passport_number": "A01234567",
        },
        expected: "A01234567",
      },
      {
        label: "second accepted citizenship",
        data: {
          "form.citizenship_status_code": "noncitizen",
          "form.employee_document_types": "list_a",
          "form.us_passport_number": "A01234567",
        },
        expected: "A01234567",
      },
      {
        label: "unaccepted citizenship",
        data: {
          "form.citizenship_status_code": "lawful_permanent_resident",
          "form.employee_document_types": "list_a",
        },
        expected: "",
      },
      {
        label: "unaccepted document list",
        data: {
          "form.citizenship_status_code": "us_citizen",
          "form.employee_document_types": "list_b_and_c",
        },
        expected: "",
      },
    ],
  },
  {
    label: "I-9 date-string copy",
    formula: '=IF(form.employee_document_types="list_a", form.document_a_expiration, "N/A")',
    cases: [
      {
        label: "preserves an ISO date as text",
        data: {
          "form.employee_document_types": "list_a",
          "form.document_a_expiration": "2030-08-02",
        },
        expected: "2030-08-02",
      },
      {
        label: "uses the literal fallback",
        data: {
          "form.employee_document_types": "list_b_and_c",
        },
        expected: "N/A",
      },
    ],
  },
  {
    label: "I-9 deeply nested document-title routing",
    formula:
      '=IF(form.listb_document_type="receipt", form.receipt_listb_document_title,\nIF(form.listb_document_type="state_dl_id",\n  IF(form.listb_state_doc_type="drivers_license", "Driver\'s License", "State-Issued ID Card"),\nIF(form.listb_document_type="government_id", form.listb_government_id_name,\nIF(form.listb_document_type="school_id", "School ID Card with Photograph",\nIF(form.listb_document_type="voter_registration", "Voter\'s Registration Card",\nIF(form.listb_document_type="military_card", form.listb_military_card_name,\nIF(form.listb_document_type="military_dependent_id", "Military Dependent\'s ID Card",\nIF(form.listb_document_type="coast_guard_card", "Merchant Mariner Card",\nIF(form.listb_document_type="native_american_doc", form.listb_native_american_doc_name,\nIF(form.listb_document_type="canadian_dl", "Canadian Driver\'s License",\nIF(form.listb_document_type="school_record_minor", form.listb_school_record_minor_name,\nIF(form.listb_document_type="medical_record_minor", form.listb_medical_record_minor_name,\nIF(form.listb_document_type="daycare_record_minor", form.listb_daycare_record_minor_name, "")))))))))))))',
    cases: [
      {
        label: "receipt uses the entered title",
        data: {
          "form.listb_document_type": "receipt",
          "form.receipt_listb_document_title": "Replacement ID receipt",
        },
        expected: "Replacement ID receipt",
      },
      {
        label: "driver license inner branch",
        data: {
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_type": "drivers_license",
        },
        expected: "Driver's License",
      },
      {
        label: "state ID inner fallback",
        data: {
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_type": "state_id",
        },
        expected: "State-Issued ID Card",
      },
      {
        label: "government ID uses the entered name",
        data: {
          "form.listb_document_type": "government_id",
          "form.listb_government_id_name": "Government ID",
        },
        expected: "Government ID",
      },
      {
        label: "school ID literal",
        data: {
          "form.listb_document_type": "school_id",
        },
        expected: "School ID Card with Photograph",
      },
      {
        label: "voter registration literal",
        data: {
          "form.listb_document_type": "voter_registration",
        },
        expected: "Voter's Registration Card",
      },
      {
        label: "military card uses the entered name",
        data: {
          "form.listb_document_type": "military_card",
          "form.listb_military_card_name": "Military ID",
        },
        expected: "Military ID",
      },
      {
        label: "military dependent literal",
        data: {
          "form.listb_document_type": "military_dependent_id",
        },
        expected: "Military Dependent's ID Card",
      },
      {
        label: "coast guard literal",
        data: {
          "form.listb_document_type": "coast_guard_card",
        },
        expected: "Merchant Mariner Card",
      },
      {
        label: "tribal document uses the entered name",
        data: {
          "form.listb_document_type": "native_american_doc",
          "form.listb_native_american_doc_name": "Tribal ID",
        },
        expected: "Tribal ID",
      },
      {
        label: "Canadian driver license literal",
        data: {
          "form.listb_document_type": "canadian_dl",
        },
        expected: "Canadian Driver's License",
      },
      {
        label: "school record near the end of the chain",
        data: {
          "form.listb_document_type": "school_record_minor",
          "form.listb_school_record_minor_name": "School Record",
        },
        expected: "School Record",
      },
      {
        label: "medical record near the end of the chain",
        data: {
          "form.listb_document_type": "medical_record_minor",
          "form.listb_medical_record_minor_name": "Medical Record",
        },
        expected: "Medical Record",
      },
      {
        label: "daycare record last branch",
        data: {
          "form.listb_document_type": "daycare_record_minor",
          "form.listb_daycare_record_minor_name": "Daycare Record",
        },
        expected: "Daycare Record",
      },
      {
        label: "unknown selection reaches the final fallback",
        data: {
          "form.listb_document_type": "unknown",
        },
        expected: "",
      },
      {
        label: "unanswered selection reaches the final fallback",
        data: {},
        expected: "",
      },
    ],
  },
  {
    label: "I-9 first nonempty identifier selection",
    formula:
      '=IF(form.uscis_alien_number<>"", "alien_uscis_number",\nIF(form.number_i94<>"", "form_i94", ""))',
    cases: [
      {
        label: "first identifier takes precedence",
        data: {
          "form.uscis_alien_number": "001234567",
          "form.number_i94": "I940123",
        },
        expected: "alien_uscis_number",
      },
      {
        label: "second identifier is the fallback",
        data: {
          "form.uscis_alien_number": null,
          "form.number_i94": "I940123",
        },
        expected: "form_i94",
      },
      {
        label: "no identifiers",
        data: {},
        expected: "",
      },
    ],
  },
  {
    label: "I-9 bare null named reference",
    formula:
      '=IF(OR(form.other_last_names="", form.other_last_names=null), "N/A", form.other_last_names)',
    cases: [
      {
        label: "unanswered last name",
        data: {},
        expected: "N/A",
        serverExpected: {
          error: "#NAME?",
        },
      },
      {
        label: "empty last name",
        data: {
          "form.other_last_names": "",
        },
        expected: "N/A",
        serverExpected: {
          error: "#NAME?",
        },
      },
      {
        label: "nonempty last name",
        data: {
          "form.other_last_names": "Example",
        },
        expected: "Example",
        serverExpected: {
          error: "#NAME?",
        },
      },
    ],
  },
  {
    label: "W-4 direct reference",
    formula: "=form.federal_w4_exempt_status",
    cases: [
      {
        label: "text option is copied",
        data: {
          "form.federal_w4_exempt_status": "exempt",
        },
        expected: "exempt",
      },
      {
        label: "boolean is copied",
        data: {
          "form.federal_w4_exempt_status": false,
        },
        expected: false,
      },
      {
        label: "blank is copied",
        data: {},
        expected: null,
      },
    ],
  },
  {
    label: "W-4 ISBLANK numeric default",
    formula:
      "=IF(ISBLANK(form.federal_w4_optional_withholding_deductions), 0, form.federal_w4_optional_withholding_deductions)",
    cases: [
      {
        label: "missing value becomes zero",
        data: {},
        expected: 0,
      },
      {
        label: "undefined value becomes zero",
        data: { "form.federal_w4_optional_withholding_deductions": undefined },
        expected: 0,
      },
      {
        label: "null value becomes zero",
        data: {
          "form.federal_w4_optional_withholding_deductions": null,
        },
        expected: 0,
      },
      {
        label: "empty text is not ISBLANK",
        data: {
          "form.federal_w4_optional_withholding_deductions": "",
        },
        expected: "",
      },
      {
        label: "zero is not lost",
        data: {
          "form.federal_w4_optional_withholding_deductions": 0,
        },
        expected: 0,
      },
      {
        label: "numeric text is coerced",
        data: {
          "form.federal_w4_optional_withholding_deductions": "125",
        },
        expected: 125,
      },
    ],
  },
  {
    label: "W-4 named-expression SUM",
    formula: "=SUM(form.federal_w4_dependents_3a, form.federal_w4_dependents_3b)",
    cases: [
      {
        label: "adds numbers",
        data: {
          "form.federal_w4_dependents_3a": 4000,
          "form.federal_w4_dependents_3b": 500,
        },
        expected: 4500,
      },
      {
        label: "adds numeric text",
        data: {
          "form.federal_w4_dependents_3a": "4000",
          "form.federal_w4_dependents_3b": "500",
        },
        expected: 4500,
      },
      {
        label: "nonnumeric named expressions produce a value error",
        data: {
          "form.federal_w4_dependents_3a": "not a number",
          "form.federal_w4_dependents_3b": 500,
        },
        expected: { error: "#VALUE!" },
      },
      {
        label: "blank values sum to zero",
        data: {},
        expected: 0,
      },
    ],
  },
  {
    label: "I-9 reviewer override precedence",
    formula:
      "=IF(NOT(ISBLANK(form.reviewer_edit_document_alien_number)), form.reviewer_edit_document_alien_number, form.alien_number)",
    cases: [
      {
        label: "reviewer value wins",
        data: {
          "form.reviewer_edit_document_alien_number": "009876543",
          "form.alien_number": "001234567",
        },
        expected: "009876543",
      },
      {
        label: "null reviewer value falls back",
        data: {
          "form.reviewer_edit_document_alien_number": null,
          "form.alien_number": "001234567",
        },
        expected: "001234567",
      },
      {
        label: "empty text counts as a reviewer value",
        data: {
          "form.reviewer_edit_document_alien_number": "",
          "form.alien_number": "001234567",
        },
        expected: "",
      },
      {
        label: "zero counts as a reviewer value",
        data: {
          "form.reviewer_edit_document_alien_number": 0,
          "form.alien_number": "001234567",
        },
        expected: 0,
      },
      {
        label: "both values missing",
        data: {},
        expected: null,
      },
    ],
  },
  {
    label: "I-9 conditional reviewer override",
    formula:
      '=IF(AND(form.reviewer_edit_document_a_type_code="form_i551",NOT(ISBLANK(form.reviewer_edit_document_a_number))),form.reviewer_edit_document_a_number,IF(form.document_a_type_code="form_i551",form.i551_number, ""))',
    cases: [
      {
        label: "matching reviewer document wins",
        data: {
          "form.reviewer_edit_document_a_type_code": "form_i551",
          "form.reviewer_edit_document_a_number": "009876543",
          "form.document_a_type_code": "form_i551",
          "form.i551_number": "001234567",
        },
        expected: "009876543",
      },
      {
        label: "wrong reviewer type falls back",
        data: {
          "form.reviewer_edit_document_a_type_code": "form_i766",
          "form.reviewer_edit_document_a_number": "009876543",
          "form.document_a_type_code": "form_i551",
          "form.i551_number": "001234567",
        },
        expected: "001234567",
      },
      {
        label: "missing reviewer value falls back",
        data: {
          "form.reviewer_edit_document_a_type_code": "form_i551",
          "form.document_a_type_code": "form_i551",
          "form.i551_number": "001234567",
        },
        expected: "001234567",
      },
      {
        label: "no matching document",
        data: {
          "form.document_a_type_code": "form_i766",
        },
        expected: "",
      },
    ],
  },
  {
    label: "Quiz equality score",
    formula: '=IF(form.radio_q6="prevent_unwashed_hands_and_surfaces", 1, 0)',
    cases: [
      {
        label: "correct option",
        data: {
          "form.radio_q6": "prevent_unwashed_hands_and_surfaces",
        },
        expected: 1,
      },
      {
        label: "comparison ignores case",
        data: {
          "form.radio_q6": "PREVENT_UNWASHED_HANDS_AND_SURFACES",
        },
        expected: 1,
      },
      {
        label: "incorrect option",
        data: {
          "form.radio_q6": "another_option",
        },
        expected: 0,
      },
      {
        label: "unanswered question",
        data: {},
        expected: 0,
      },
    ],
  },
  {
    label: "Quiz FIND TRIM and ISERROR score",
    formula: '=IF(ISERROR(FIND("correct",TRIM(form.radio_q9_1))),0,1)',
    cases: [
      {
        label: "trims the answer",
        data: {
          "form.radio_q9_1": "  correct  ",
        },
        expected: 1,
      },
      {
        label: "finds a substring",
        data: {
          "form.radio_q9_1": "choice_correct",
        },
        expected: 1,
      },
      {
        label: "FIND is case sensitive",
        data: {
          "form.radio_q9_1": "CORRECT",
        },
        expected: 0,
      },
      {
        label: "no substring",
        data: {
          "form.radio_q9_1": "wrong",
        },
        expected: 0,
      },
      {
        label: "unanswered question",
        data: {},
        expected: 0,
      },
    ],
  },
  {
    label: "Withholding SUBSTITUTE output",
    formula: '=SUBSTITUTE(form.az_withholding_percentage,"_",".")',
    cases: [
      {
        label: "replaces the stored option separator",
        data: {
          "form.az_withholding_percentage": "2_5",
        },
        expected: "2.5",
      },
      {
        label: "replaces every occurrence",
        data: {
          "form.az_withholding_percentage": "1_2_3",
        },
        expected: "1.2.3",
      },
      {
        label: "returns numeric input as text",
        data: {
          "form.az_withholding_percentage": 2,
        },
        expected: "2",
      },
      {
        label: "unanswered option becomes empty text",
        data: {},
        expected: "",
      },
    ],
  },
  {
    label: "I-9 checkbox TRUE and NOT",
    formula:
      '=IF(AND(form.employee_document_types="list_b_and_c", form.listb_document_type="state_dl_id"),\n  NOT(form.listb_state_doc_no_expiration=TRUE()),\n"")',
    cases: [
      {
        label: "no-expiration checkbox is true",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_no_expiration": true,
        },
        expected: false,
      },
      {
        label: "no-expiration checkbox is false",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
          "form.listb_state_doc_no_expiration": false,
        },
        expected: true,
      },
      {
        label: "no-expiration checkbox is missing",
        data: {
          "form.employee_document_types": "list_b_and_c",
          "form.listb_document_type": "state_dl_id",
        },
        expected: true,
      },
      {
        label: "different document list",
        data: {
          "form.employee_document_types": "list_a",
        },
        expected: "",
      },
    ],
  },
  {
    label: "Withholding multi-select SEARCH and ISNUMBER",
    formula:
      '=IF(ISNUMBER(SEARCH("head_of_household", form.massachusetts_state_options)), "Head of Household", null)',
    cases: [
      {
        label: "selected option is found in the joined array",
        data: {
          "form.massachusetts_state_options": ["personal_blind", "head_of_household"],
        },
        expected: "Head of Household",
      },
      {
        label: "SEARCH ignores case",
        data: {
          "form.massachusetts_state_options": ["HEAD_OF_HOUSEHOLD"],
        },
        expected: "Head of Household",
      },
      {
        label: "missing option uses the null named reference",
        data: {
          "form.massachusetts_state_options": ["personal_blind"],
        },
        expected: null,
        serverExpected: {
          error: "#NAME?",
        },
      },
      {
        label: "empty multi-select uses the null named reference",
        data: {
          "form.massachusetts_state_options": [],
        },
        expected: null,
        serverExpected: {
          error: "#NAME?",
        },
      },
      {
        label: "unanswered multi-select",
        data: {},
        expected: null,
        serverExpected: {
          error: "#NAME?",
        },
      },
    ],
  },
  {
    label: "Direct deposit EXACT comparison",
    formula:
      "=EXACT(form.bank_account_1_account_number, form.bank_account_1_account_number_confirmation)",
    cases: [
      {
        label: "equal account numbers keep leading zeros",
        data: {
          "form.bank_account_1_account_number": "001234567",
          "form.bank_account_1_account_number_confirmation": "001234567",
        },
        expected: true,
      },
      {
        label: "different leading zeros are not equal",
        data: {
          "form.bank_account_1_account_number": "001234567",
          "form.bank_account_1_account_number_confirmation": "1234567",
        },
        expected: false,
      },
      {
        label: "long account numbers stay distinct",
        data: {
          "form.bank_account_1_account_number": "12345678901234567890",
          "form.bank_account_1_account_number_confirmation": "12345678901234567891",
        },
        expected: false,
      },
      {
        label: "EXACT is case sensitive",
        data: {
          "form.bank_account_1_account_number": "AbC",
          "form.bank_account_1_account_number_confirmation": "abc",
        },
        expected: false,
      },
      {
        label: "two blanks are equal",
        data: {},
        expected: true,
      },
    ],
  },
  {
    label: "Withholding conditional addition",
    formula:
      "=form.ga_withholding_dependent_allowances_total + IF(form.ga_withholding_additional_status=TRUE(), form.ga_withholding_additional_worksheet_line_h, 0)",
    cases: [
      {
        label: "adds the optional allowance",
        data: {
          "form.ga_withholding_dependent_allowances_total": 2,
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_h": 3,
        },
        expected: 5,
      },
      {
        label: "disabled optional allowance",
        data: {
          "form.ga_withholding_dependent_allowances_total": 2,
          "form.ga_withholding_additional_status": false,
          "form.ga_withholding_additional_worksheet_line_h": 3,
        },
        expected: 2,
      },
      {
        label: "blank optional allowance",
        data: {
          "form.ga_withholding_dependent_allowances_total": 2,
          "form.ga_withholding_additional_status": true,
        },
        expected: 2,
      },
    ],
  },
  {
    label: "Withholding INT and MOD rounding boundary",
    formula:
      "=IF(AND(form.ga_withholding_additional_status=TRUE(), form.ga_withholding_additional_worksheet_line_g>0), INT(form.ga_withholding_additional_worksheet_line_g/5000) + IF(MOD(form.ga_withholding_additional_worksheet_line_g,5000)>2500,1,0), 0)",
    cases: [
      {
        label: "below half a unit",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": 2499,
        },
        expected: 0,
      },
      {
        label: "exactly half a unit rounds down",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": 2500,
        },
        expected: 0,
      },
      {
        label: "above half a unit rounds up",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": 2501,
        },
        expected: 1,
      },
      {
        label: "exactly one unit",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": 5000,
        },
        expected: 1,
      },
      {
        label: "one and a half units rounds down",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": 7500,
        },
        expected: 1,
      },
      {
        label: "more than one and a half units rounds up",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": 7501,
        },
        expected: 2,
      },
      {
        label: "nonpositive amount",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_g": -1,
        },
        expected: 0,
      },
      {
        label: "checkbox disables the calculation",
        data: {
          "form.ga_withholding_additional_status": false,
          "form.ga_withholding_additional_worksheet_line_g": 7501,
        },
        expected: 0,
      },
    ],
  },
  {
    label: "Withholding MAX subtraction floor",
    formula:
      "=IF(form.ga_withholding_additional_status=TRUE(), MAX(0, form.ga_withholding_additional_worksheet_line_a - form.ga_withholding_additional_worksheet_line_b), 0)",
    cases: [
      {
        label: "positive difference",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_a": 9000,
          "form.ga_withholding_additional_worksheet_line_b": 4000,
        },
        expected: 5000,
      },
      {
        label: "negative difference is floored at zero",
        data: {
          "form.ga_withholding_additional_status": true,
          "form.ga_withholding_additional_worksheet_line_a": 1000,
          "form.ga_withholding_additional_worksheet_line_b": 4000,
        },
        expected: 0,
      },
      {
        label: "checkbox disables the calculation",
        data: {
          "form.ga_withholding_additional_status": false,
          "form.ga_withholding_additional_worksheet_line_a": 9000,
          "form.ga_withholding_additional_worksheet_line_b": 4000,
        },
        expected: 0,
      },
      {
        label: "blank amounts",
        data: {
          "form.ga_withholding_additional_status": true,
        },
        expected: 0,
      },
    ],
  },
];
