"""Page-number pagination: `?page=1&pageSize=25` -> `{ items, page, pageSize, total, totalPages }`."""

from __future__ import annotations

import math
from typing import Any

from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response


class PagePagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "pageSize"
    max_page_size = 200

    def get_paginated_response(self, data: Any) -> Response:
        assert self.page is not None
        total = self.page.paginator.count
        size = self.page.paginator.per_page
        return Response(
            {
                "items": data,
                "page": self.page.number,
                "page_size": size,
                "total": total,
                "total_pages": max(1, math.ceil(total / size)) if size else 1,
            }
        )
