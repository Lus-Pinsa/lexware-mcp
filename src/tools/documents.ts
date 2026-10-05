  server.registerTool(
    {
      name: "get-voucherlist",
      description:
        "Search the voucher list — the primary index of all financial documents. Supports voucher-date, creation-date and update-date filters. voucherType and voucherStatus default to 'any'. Results are paged.",
      inputSchema: {
        voucherType: z.enum(VOUCHER_TYPES).default("any"),
        voucherStatus: z.enum(VOUCHER_STATUSES).default("any"),

        contactId: z.string().optional(),

        voucherDateFrom: z
          .string()
          .optional()
          .describe("Voucher date lower bound, YYYY-MM-DD."),

        voucherDateTo: z
          .string()
          .optional()
          .describe("Voucher date upper bound, YYYY-MM-DD."),

        createdDateFrom: z
          .string()
          .optional()
          .describe(
            "Lexware creation date lower bound, YYYY-MM-DD. Use this for restart/reconciliation checks.",
          ),

        createdDateTo: z
          .string()
          .optional()
          .describe(
            "Lexware creation date upper bound, YYYY-MM-DD.",
          ),

        updatedDateFrom: z
          .string()
          .optional()
          .describe(
            "Lexware last-update date lower bound, YYYY-MM-DD.",
          ),

        updatedDateTo: z
          .string()
          .optional()
          .describe(
            "Lexware last-update date upper bound, YYYY-MM-DD.",
          ),

        voucherNumber: z
          .string()
          .optional()
          .describe("Exact voucher number filter."),

        archived: jsonBool(
          z.boolean().optional(),
        ),

        sort: z
          .string()
          .optional()
          .describe(
            "Lexware voucherlist sort, e.g. createdDate,DESC or updatedDate,DESC.",
          ),

        page: pageParam,
        size: sizeParam,
      },
      annotations: RO,
    },
    async ({
      voucherType,
      voucherStatus,
      contactId,
      voucherDateFrom,
      voucherDateTo,
      createdDateFrom,
      createdDateTo,
      updatedDateFrom,
      updatedDateTo,
      voucherNumber,
      archived,
      sort,
      page,
      size,
    }) => {
      const result =
        await client.get<Paged<VoucherlistEntry>>(
          "/v1/voucherlist",
          {
            voucherType,
            voucherStatus,
            contactId,
            voucherDateFrom,
            voucherDateTo,
            createdDateFrom,
            createdDateTo,
            updatedDateFrom,
            updatedDateTo,
            voucherNumber,
            archived,
            sort,
            page,
            size,
          },
        );

      return pagedResult(
        result,
        "voucher(s)",
      );
    },
  );
